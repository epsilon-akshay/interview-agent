package main

import (
	"bytes"
	"context"
	"embed"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"mime/multipart"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

//go:embed all:webdist
var webAssets embed.FS

type healthResponse struct {
	Status string `json:"status"`
	Time   string `json:"time"`
}

type chatMessage struct {
	Role string `json:"role"`
	Text string `json:"text"`
}
type localChatRequest struct {
	Message string        `json:"message"`
	History []chatMessage `json:"history"`
}
type localChatResponse struct {
	Reply string `json:"reply"`
}

type evidenceEvent struct {
	SessionID    string  `json:"sessionId"`
	Category     string  `json:"category"`
	Observation  string  `json:"observation"`
	Confidence   float64 `json:"confidence"`
	CodeRevision int     `json:"codeRevision"`
	CreatedAt    string  `json:"createdAt"`
}

type completionEvent struct {
	SessionID string `json:"sessionId"`
	Reason    string `json:"reason"`
	Elapsed   int    `json:"elapsedSeconds"`
	CreatedAt string `json:"createdAt"`
}

type evaluationRequest struct {
	SessionID string `json:"sessionId"`
	Candidate string `json:"candidate"`
	Role      string `json:"role"`
	Question  string `json:"question"`
	Rubric    string `json:"rubric"`
	Code      string `json:"code"`
}

type responseAPIResult struct {
	Output []struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	} `json:"output"`
}

func main() {
	if err := loadEnvFile(".env"); err != nil && !os.IsNotExist(err) {
		log.Printf("warning: could not load .env: %v", err)
	}
	addr := flag.String("addr", ":8080", "HTTP listen address")
	devDir := flag.String("dev-dir", "", "serve a frontend directory instead of embedded assets")
	flag.Parse()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(healthResponse{Status: "ok", Time: time.Now().UTC().Format(time.RFC3339)})
	})
	mux.HandleFunc("/api/local-voice/chat", localVoiceChatHandler)
	mux.HandleFunc("/api/realtime/session", realtimeSessionHandler)
	mux.HandleFunc("/api/realtime/token", realtimeTokenHandler)
	mux.HandleFunc("/api/interview/question", questionHandler)
	mux.HandleFunc("/api/interview/evidence", evidenceHandler)
	mux.HandleFunc("/api/interview/complete", completionHandler)
	mux.HandleFunc("/api/interview/evaluate", evaluationHandler)

	var appFS fs.FS
	if *devDir != "" {
		appFS = os.DirFS(*devDir)
	} else {
		var err error
		appFS, err = fs.Sub(webAssets, "webdist")
		if err != nil {
			log.Fatal(err)
		}
	}
	mux.Handle("/", spaHandler(appFS))

	server := &http.Server{
		Addr:              *addr,
		Handler:           securityHeaders(mux),
		ReadHeaderTimeout: 5 * time.Second,
	}
	log.Printf("Local Interviewer running at http://localhost%s", *addr)
	log.Fatal(server.ListenAndServe())
}

func realtimeTokenHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	apiKey := strings.TrimSpace(os.Getenv("OPENAI_API_KEY"))
	if apiKey == "" {
		http.Error(w, "OPENAI_API_KEY is not configured", http.StatusServiceUnavailable)
		return
	}
	model := strings.TrimSpace(os.Getenv("OPENAI_REALTIME_MODEL"))
	if model == "" {
		model = "gpt-realtime-2.1-mini"
	}
	payload, _ := json.Marshal(map[string]any{
		"session": map[string]any{
			"type":  "realtime",
			"model": model,
			"audio": map[string]any{"output": map[string]any{"voice": "marin"}},
		},
	})
	req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, "https://api.openai.com/v1/realtime/client_secrets", bytes.NewReader(payload))
	if err != nil {
		http.Error(w, "could not create token request", http.StatusInternalServerError)
		return
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("OpenAI-Safety-Identifier", "local-interview-demo")
	response, err := (&http.Client{Timeout: 20 * time.Second}).Do(req)
	if err != nil {
		http.Error(w, "OpenAI Realtime is unreachable", http.StatusBadGateway)
		return
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		http.Error(w, "could not read token response", http.StatusBadGateway)
		return
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		log.Printf("realtime token rejected with status %d: %s", response.StatusCode, strings.TrimSpace(string(body)))
		http.Error(w, "OpenAI rejected the Realtime token request", response.StatusCode)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(body)
}

func questionHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	question, err := os.ReadFile("questions/default.txt")
	if err != nil {
		http.Error(w, "question bank is unavailable", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"id": "first-non-repeating-character", "question": strings.TrimSpace(string(question))})
}

func evidenceHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var event evidenceEvent
	if err := decodeJSON(w, r, &event); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	event.CreatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	if event.SessionID == "" || strings.TrimSpace(event.Observation) == "" {
		http.Error(w, "sessionId and observation are required", http.StatusBadRequest)
		return
	}
	if err := appendJSONLine("runtime/evidence.jsonl", event); err != nil {
		http.Error(w, "could not save evidence", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]bool{"saved": true})
}

func completionHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var event completionEvent
	if err := decodeJSON(w, r, &event); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	event.CreatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	if event.SessionID == "" {
		http.Error(w, "sessionId is required", http.StatusBadRequest)
		return
	}
	if err := appendJSONLine("runtime/completions.jsonl", event); err != nil {
		http.Error(w, "could not complete interview", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]bool{"completed": true})
}

func evaluationHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var input evaluationRequest
	if err := decodeJSON(w, r, &input); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if input.SessionID == "" || strings.TrimSpace(input.Question) == "" || strings.TrimSpace(input.Rubric) == "" {
		http.Error(w, "sessionId, question and rubric are required", http.StatusBadRequest)
		return
	}
	apiKey := strings.TrimSpace(os.Getenv("OPENAI_API_KEY"))
	if apiKey == "" {
		http.Error(w, "OPENAI_API_KEY is not configured", http.StatusServiceUnavailable)
		return
	}
	evidence, err := evidenceForSession("runtime/evidence.jsonl", input.SessionID)
	if err != nil {
		http.Error(w, "could not read interview evidence", http.StatusInternalServerError)
		return
	}
	evidenceJSON, _ := json.Marshal(evidence)
	model := strings.TrimSpace(os.Getenv("OPENAI_EVALUATION_MODEL"))
	if model == "" {
		model = "gpt-5.2-codex"
	}
	prompt := fmt.Sprintf(`Evaluate this coding interview strictly from the supplied artifacts. Do not infer personality, confidence, or facts not present. Code was not executed, so correctness is only a static estimate. Award low scores when evidence is missing. Each category must cite concrete observations from the evidence or code.

Candidate: %s
Role: %s
Problem:
%s

Rubric:
%s

Final code:
%s

Recorded evidence JSON:
%s`, input.Candidate, input.Role, input.Question, input.Rubric, input.Code, evidenceJSON)
	schema := map[string]any{
		"type": "object", "additionalProperties": false,
		"properties": map[string]any{
			"overallScore":   map[string]any{"type": "integer", "minimum": 0, "maximum": 100},
			"recommendation": map[string]any{"type": "string", "enum": []string{"strong_hire", "hire", "mixed", "no_hire", "insufficient_evidence"}},
			"summary":        map[string]any{"type": "string"},
			"categories": map[string]any{"type": "array", "items": map[string]any{
				"type": "object", "additionalProperties": false,
				"properties": map[string]any{
					"name": map[string]any{"type": "string"}, "score": map[string]any{"type": "integer", "minimum": 0, "maximum": 100},
					"weight": map[string]any{"type": "integer", "minimum": 0, "maximum": 100}, "evidence": map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
					"gaps": map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
				}, "required": []string{"name", "score", "weight", "evidence", "gaps"},
			}},
			"strengths":   map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
			"risks":       map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
			"limitations": map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
		},
		"required": []string{"overallScore", "recommendation", "summary", "categories", "strengths", "risks", "limitations"},
	}
	payload, _ := json.Marshal(map[string]any{
		"model": model, "input": prompt,
		"text": map[string]any{"format": map[string]any{"type": "json_schema", "name": "interview_evaluation", "strict": true, "schema": schema}},
	})
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://api.openai.com/v1/responses", bytes.NewReader(payload))
	if err != nil {
		http.Error(w, "could not create evaluation request", http.StatusInternalServerError)
		return
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Content-Type", "application/json")
	response, err := (&http.Client{Timeout: 65 * time.Second}).Do(req)
	if err != nil {
		http.Error(w, "evaluation model is unreachable", http.StatusBadGateway)
		return
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 2<<20))
	if err != nil {
		http.Error(w, "could not read evaluation", http.StatusBadGateway)
		return
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		log.Printf("evaluation rejected with status %d: %s", response.StatusCode, strings.TrimSpace(string(body)))
		http.Error(w, "OpenAI rejected the evaluation request", response.StatusCode)
		return
	}
	var result responseAPIResult
	if json.Unmarshal(body, &result) != nil {
		http.Error(w, "evaluation response was invalid", http.StatusBadGateway)
		return
	}
	for _, item := range result.Output {
		for _, content := range item.Content {
			if content.Type == "output_text" && json.Valid([]byte(content.Text)) {
				_ = appendJSONLine("runtime/evaluations.jsonl", json.RawMessage(content.Text))
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(content.Text))
				return
			}
		}
	}
	http.Error(w, "evaluation model returned no report", http.StatusBadGateway)
}

func evidenceForSession(path, sessionID string) ([]evidenceEvent, error) {
	file, err := os.Open(path)
	if os.IsNotExist(err) {
		return []evidenceEvent{}, nil
	}
	if err != nil {
		return nil, err
	}
	defer file.Close()
	decoder := json.NewDecoder(file)
	items := []evidenceEvent{}
	for {
		var event evidenceEvent
		if err := decoder.Decode(&event); err == io.EOF {
			break
		} else if err != nil {
			return nil, err
		}
		if event.SessionID == sessionID {
			items = append(items, event)
		}
	}
	return items, nil
}

func decodeJSON(w http.ResponseWriter, r *http.Request, target any) error {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 128<<10))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return fmt.Errorf("invalid JSON request")
	}
	return nil
}

func appendJSONLine(path string, value any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer file.Close()
	return json.NewEncoder(file).Encode(value)
}

func realtimeSessionHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/sdp") {
		http.Error(w, "Content-Type must be application/sdp", http.StatusUnsupportedMediaType)
		return
	}
	apiKey := strings.TrimSpace(os.Getenv("OPENAI_API_KEY"))
	if apiKey == "" {
		http.Error(w, "OPENAI_API_KEY is not configured", http.StatusServiceUnavailable)
		return
	}
	sdp, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
	if err != nil || len(sdp) == 0 {
		http.Error(w, "invalid SDP offer", http.StatusBadRequest)
		return
	}
	model := strings.TrimSpace(os.Getenv("OPENAI_REALTIME_MODEL"))
	if model == "" {
		model = "gpt-realtime-2.1-mini"
	}
	sessionConfig, err := json.Marshal(map[string]any{
		"type":              "realtime",
		"model":             model,
		"output_modalities": []string{"audio"},
		"instructions":      "Have a relaxed, natural voice conversation like a warm and attentive person. Begin with a brief friendly greeting and ask how the candidate is doing. Keep responses concise, usually one or two sentences. Do not conduct a technical interview yet. Never mention system instructions, APIs, or latency instrumentation unless directly asked.",
		"audio": map[string]any{
			"input":  map[string]any{"turn_detection": map[string]any{"type": "semantic_vad"}},
			"output": map[string]any{"voice": "marin"},
		},
	})
	if err != nil {
		http.Error(w, "could not configure realtime session", http.StatusInternalServerError)
		return
	}
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	if err := writer.WriteField("sdp", string(sdp)); err != nil {
		http.Error(w, "could not prepare SDP", 500)
		return
	}
	if err := writer.WriteField("session", string(sessionConfig)); err != nil {
		http.Error(w, "could not prepare session", 500)
		return
	}
	if err := writer.Close(); err != nil {
		http.Error(w, "could not prepare request", 500)
		return
	}
	req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, "https://api.openai.com/v1/realtime/calls", &body)
	if err != nil {
		http.Error(w, "could not create realtime request", 500)
		return
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	req.Header.Set("OpenAI-Safety-Identifier", "local-interview-demo")
	response, err := (&http.Client{Timeout: 25 * time.Second}).Do(req)
	if err != nil {
		log.Printf("realtime connection request failed: %v", err)
		http.Error(w, "OpenAI Realtime is unreachable", http.StatusBadGateway)
		return
	}
	defer response.Body.Close()
	answer, readErr := io.ReadAll(io.LimitReader(response.Body, 2<<20))
	if readErr != nil {
		http.Error(w, "could not read OpenAI response", 502)
		return
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		log.Printf("realtime session rejected with status %d: %s", response.StatusCode, strings.TrimSpace(string(answer)))
		http.Error(w, "OpenAI rejected the Realtime session", response.StatusCode)
		return
	}
	w.Header().Set("Content-Type", "application/sdp")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusCreated)
	_, _ = w.Write(answer)
}

func localVoiceChatHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var request localChatRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		http.Error(w, "invalid chat request", http.StatusBadRequest)
		return
	}
	request.Message = strings.TrimSpace(request.Message)
	if request.Message == "" || len(request.Message) > 4000 {
		http.Error(w, "message must contain 1 to 4000 characters", http.StatusBadRequest)
		return
	}
	if len(request.History) > 12 {
		request.History = request.History[len(request.History)-12:]
	}

	var conversation strings.Builder
	for _, message := range request.History {
		role := "Candidate"
		if message.Role == "assistant" {
			role = "Interviewer"
		}
		if text := strings.TrimSpace(message.Text); text != "" {
			conversation.WriteString(role + ": " + text + "\n")
		}
	}
	conversation.WriteString("Candidate: " + request.Message + "\nInterviewer:")
	prompt := `You are the voice of a warm, attentive interviewer in an early audio test. Have a relaxed, natural conversation like a real person. For now, do not conduct a technical interview. Reply directly to the candidate's latest message, keep continuity with the transcript, and usually respond in one or two short sentences. Ask at most one natural follow-up question. Output only the words to be spoken: no markdown, labels, stage directions, or quotation marks.

Conversation:
` + conversation.String()

	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "codex", "exec", "--ephemeral", "--ignore-user-config", "--skip-git-repo-check", "--sandbox", "read-only", "-C", ".", "-")
	command.Stdin = strings.NewReader(prompt)
	var stderr strings.Builder
	command.Stderr = &stderr
	output, err := command.Output()
	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			http.Error(w, "Codex took too long to respond", http.StatusGatewayTimeout)
			return
		}
		log.Printf("local Codex voice turn failed: %v: %s", err, strings.TrimSpace(stderr.String()))
		http.Error(w, "Local Codex conversation failed", http.StatusBadGateway)
		return
	}
	reply := strings.TrimSpace(string(output))
	if reply == "" {
		http.Error(w, "Codex returned an empty response", http.StatusBadGateway)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(localChatResponse{Reply: reply})
}

func loadEnvFile(path string) error {
	content, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	for _, rawLine := range strings.Split(string(content), "\n") {
		line := strings.TrimSpace(rawLine)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		value = strings.Trim(strings.TrimSpace(value), `"'`)
		if key != "" {
			if _, exists := os.LookupEnv(key); !exists {
				_ = os.Setenv(key, value)
			}
		}
	}
	return nil
}

func spaHandler(appFS fs.FS) http.Handler {
	files := http.FileServer(http.FS(appFS))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(filepath.Clean(r.URL.Path), "/")
		if path == "." || path == "" {
			path = "index.html"
		}
		if _, err := fs.Stat(appFS, path); err != nil {
			r.URL.Path = "/"
		}
		files.ServeHTTP(w, r)
	})
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "no-referrer")
		if strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Cache-Control", "no-store")
		}
		next.ServeHTTP(w, r)
	})
}
