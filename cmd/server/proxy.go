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
	"/v1/responses":        true,
	"/v1/chat/completions": true,
}

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
	request, err := http.NewRequestWithContext(r.Context(), http.MethodPost, "https://api.openai.com"+path, strings.NewReader(string(body)))
	if err != nil {
		http.Error(w, "could not create upstream request", http.StatusInternalServerError)
		return
	}
	request.Header.Set("Authorization", "Bearer "+apiKey)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("OpenAI-Safety-Identifier", "local-interview-demo")

	response, err := (&http.Client{Timeout: 60 * time.Second}).Do(request)
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
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		log.Printf("openai proxy %s returned %d: %s", path, response.StatusCode, strings.TrimSpace(string(upstream)))
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(response.StatusCode)
	_, _ = w.Write(upstream)
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
		fallback = "gpt-5.2-codex"
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
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"observerModel":"` + observer + `","orchestratorModel":"` + orchestrator + `","realtimeModel":"` + realtime + `"}`))
}
