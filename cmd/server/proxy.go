package main

import (
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"
)

// allowedProxyPaths lists the OpenAI API paths the browser may reach.
// Anything else is rejected so the proxy cannot be used as an open relay.
var allowedProxyPaths = map[string]bool{
	"/v1/responses": true,
}

var openAIProxyBaseURL = "https://api.openai.com"
var openAIProxyHTTPClient = &http.Client{Timeout: 60 * time.Second}

func openAIProxyHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	path := strings.TrimPrefix(r.URL.Path, "/api/openai")
	if !allowedProxyPaths[path] {
		http.Error(w, "path not allowed", http.StatusForbidden)
		return
	}
	apiKey := strings.TrimSpace(os.Getenv("OPENAI_API_KEY"))
	if apiKey == "" {
		http.Error(w, "OPENAI_API_KEY is not configured", http.StatusServiceUnavailable)
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 4<<20))
	if err != nil {
		http.Error(w, "could not read request body", http.StatusBadRequest)
		return
	}
	request, err := http.NewRequestWithContext(r.Context(), http.MethodPost, openAIProxyBaseURL+path, strings.NewReader(string(body)))
	if err != nil {
		http.Error(w, "could not create upstream request", http.StatusInternalServerError)
		return
	}
	request.Header.Set("Authorization", "Bearer "+apiKey)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("OpenAI-Safety-Identifier", "local-interview-demo")

	response, err := openAIProxyHTTPClient.Do(request)
	if err != nil {
		http.Error(w, "OpenAI is unreachable", http.StatusBadGateway)
		return
	}
	defer response.Body.Close()

	upstream, err := io.ReadAll(io.LimitReader(response.Body, 8<<20))
	if err != nil {
		http.Error(w, "could not read upstream response", http.StatusBadGateway)
		return
	}
	status := response.StatusCode
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		log.Printf("openai proxy path=%s provider_status=%d", path, response.StatusCode)
		upstream, status = safeProxyErrorBody(response.StatusCode)
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = w.Write(upstream)
}

func safeProxyErrorBody(providerStatus int) ([]byte, int) {
	status := http.StatusBadGateway
	message := "AI provider is temporarily unavailable. Please retry."
	code := "provider_unavailable"
	switch providerStatus {
	case http.StatusUnauthorized, http.StatusForbidden:
		message = "AI provider rejected the server credentials."
		code = "provider_auth"
	case http.StatusTooManyRequests:
		status = http.StatusTooManyRequests
		message = "AI provider is busy. Please retry shortly."
		code = "provider_rate_limit"
	case http.StatusRequestTimeout, http.StatusGatewayTimeout:
		status = http.StatusGatewayTimeout
		message = "AI provider timed out. Please retry."
		code = "provider_timeout"
	}
	encoded := `{"error":{"message":"` + message + `","type":"provider_error","code":"` + code + `"}}`
	return []byte(encoded), status
}

func configHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	observer := strings.TrimSpace(os.Getenv("OPENAI_OBSERVER_MODEL"))
	orchestrator := strings.TrimSpace(os.Getenv("OPENAI_ORCHESTRATOR_MODEL"))
	realtime := strings.TrimSpace(os.Getenv("OPENAI_REALTIME_MODEL"))
	fallback := strings.TrimSpace(os.Getenv("OPENAI_EVALUATION_MODEL"))
	if fallback == "" {
		fallback = "gpt-5.6-terra"
	}
	if observer == "" {
		observer = fallback
	}
	if orchestrator == "" {
		orchestrator = fallback
	}
	if realtime == "" {
		realtime = "gpt-realtime-2.1-mini"
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"observerModel": observer, "orchestratorModel": orchestrator, "realtimeModel": realtime,
		"developerMode": developerModeEnabled(),
	})
}

func developerModeEnabled() bool {
	value := strings.ToLower(strings.TrimSpace(os.Getenv("INTERVIEW_DEVELOPER_MODE")))
	return value == "1" || value == "true" || value == "yes"
}
