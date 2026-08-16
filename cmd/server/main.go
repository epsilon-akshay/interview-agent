package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

//go:embed all:webdist
var webAssets embed.FS

type healthResponse struct {
	Status string `json:"status"`
	Time   string `json:"time"`
}

type evidenceEvent struct {
	SessionID             string  `json:"sessionId"`
	EventID               string  `json:"eventId"`
	Category              string  `json:"category"`
	Observation           string  `json:"observation"`
	Confidence            float64 `json:"confidence"`
	CodeRevision          int     `json:"codeRevision"`
	WhiteboardRevision    int     `json:"whiteboardRevision"`
	CreatedAt             string  `json:"createdAt"`
	confidenceSet         bool
	codeRevisionSet       bool
	whiteboardRevisionSet bool
}

func (event *evidenceEvent) UnmarshalJSON(raw []byte) error {
	type wireEvidenceEvent struct {
		SessionID          string   `json:"sessionId"`
		EventID            string   `json:"eventId"`
		Category           string   `json:"category"`
		Observation        string   `json:"observation"`
		Confidence         *float64 `json:"confidence"`
		CodeRevision       *int     `json:"codeRevision"`
		WhiteboardRevision *int     `json:"whiteboardRevision"`
		CreatedAt          string   `json:"createdAt"`
	}
	var wire wireEvidenceEvent
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&wire); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return fmt.Errorf("multiple JSON values")
	}
	event.SessionID, event.EventID, event.Category, event.Observation, event.CreatedAt = wire.SessionID, wire.EventID, wire.Category, wire.Observation, wire.CreatedAt
	event.confidenceSet, event.codeRevisionSet, event.whiteboardRevisionSet = wire.Confidence != nil, wire.CodeRevision != nil, wire.WhiteboardRevision != nil
	if wire.Confidence != nil {
		event.Confidence = *wire.Confidence
	}
	if wire.CodeRevision != nil {
		event.CodeRevision = *wire.CodeRevision
	}
	if wire.WhiteboardRevision != nil {
		event.WhiteboardRevision = *wire.WhiteboardRevision
	}
	return nil
}

type completionEvent struct {
	SessionID string `json:"sessionId"`
	Reason    string `json:"reason"`
	Elapsed   int    `json:"elapsedSeconds"`
	CreatedAt string `json:"createdAt"`
}

type finalArtifactsRequest struct {
	SessionID             string `json:"sessionId"`
	CodeRevision          int    `json:"codeRevision"`
	Code                  string `json:"code"`
	WhiteboardRevision    int    `json:"whiteboardRevision"`
	WhiteboardSummary     string `json:"whiteboardSummary"`
	WhiteboardScene       string `json:"whiteboardScene"`
	WhiteboardImage       string `json:"whiteboardImage"`
	codeRevisionSet       bool
	codeSet               bool
	whiteboardRevisionSet bool
	whiteboardSummarySet  bool
}

func (input *finalArtifactsRequest) UnmarshalJSON(raw []byte) error {
	type wireFinalArtifactsRequest struct {
		SessionID          string  `json:"sessionId"`
		CodeRevision       *int    `json:"codeRevision"`
		Code               *string `json:"code"`
		WhiteboardRevision *int    `json:"whiteboardRevision"`
		WhiteboardSummary  *string `json:"whiteboardSummary"`
		WhiteboardScene    *string `json:"whiteboardScene"`
		WhiteboardImage    *string `json:"whiteboardImage"`
	}
	var wire wireFinalArtifactsRequest
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&wire); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return fmt.Errorf("multiple JSON values")
	}
	input.SessionID = wire.SessionID
	input.codeRevisionSet = wire.CodeRevision != nil
	input.codeSet = wire.Code != nil
	input.whiteboardRevisionSet = wire.WhiteboardRevision != nil
	input.whiteboardSummarySet = wire.WhiteboardSummary != nil
	if wire.CodeRevision != nil {
		input.CodeRevision = *wire.CodeRevision
	}
	if wire.Code != nil {
		input.Code = *wire.Code
	}
	if wire.WhiteboardRevision != nil {
		input.WhiteboardRevision = *wire.WhiteboardRevision
	}
	if wire.WhiteboardSummary != nil {
		input.WhiteboardSummary = *wire.WhiteboardSummary
	}
	if wire.WhiteboardScene != nil {
		input.WhiteboardScene = *wire.WhiteboardScene
	}
	if wire.WhiteboardImage != nil {
		input.WhiteboardImage = *wire.WhiteboardImage
	}
	return nil
}

type storedFinalArtifacts struct {
	SessionID             string `json:"sessionId"`
	SourceVersion         int    `json:"sourceVersion"`
	CodeRevision          int    `json:"codeRevision"`
	CodeSHA256            string `json:"codeSha256"`
	WhiteboardRevision    int    `json:"whiteboardRevision"`
	WhiteboardSummary     string `json:"whiteboardSummary"`
	WhiteboardSceneSHA256 string `json:"whiteboardSceneSha256"`
	WhiteboardPNGSHA256   string `json:"whiteboardPngSha256"`
	CreatedAt             string `json:"createdAt"`
}

type evaluationRequest struct {
	SessionID     string           `json:"sessionId"`
	Transcript    []transcriptTurn `json:"transcript"`
	transcriptSet bool
}

type transcriptTurn struct {
	Role string `json:"role"`
	Text string `json:"text"`
}

func (input *evaluationRequest) UnmarshalJSON(raw []byte) error {
	type wireEvaluationRequest struct {
		SessionID  string          `json:"sessionId"`
		Transcript json.RawMessage `json:"transcript"`
	}
	var wire wireEvaluationRequest
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&wire); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return fmt.Errorf("multiple JSON values")
	}
	if wire.Transcript == nil {
		return fmt.Errorf("transcript is required")
	}
	var transcript []transcriptTurn
	if err := json.Unmarshal(wire.Transcript, &transcript); err != nil || transcript == nil {
		return fmt.Errorf("transcript must be an array")
	}
	input.SessionID, input.Transcript, input.transcriptSet = wire.SessionID, transcript, true
	return nil
}

type responseAPIResult struct {
	ID     string `json:"id"`
	Output []struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	} `json:"output"`
}

type evaluationCategoryJudgment struct {
	ID       string   `json:"id"`
	Score    *int     `json:"score"`
	Evidence []string `json:"evidence"`
	Gaps     []string `json:"gaps"`
}

type evaluationJudgment struct {
	Recommendation string                       `json:"recommendation"`
	Summary        string                       `json:"summary"`
	Categories     []evaluationCategoryJudgment `json:"categories"`
	Strengths      []string                     `json:"strengths"`
	Risks          []string                     `json:"risks"`
	Limitations    []string                     `json:"limitations"`
}

type evaluationCategory struct {
	ID       string   `json:"id"`
	Name     string   `json:"name"`
	Score    int      `json:"score"`
	Weight   int      `json:"weight"`
	Evidence []string `json:"evidence"`
	Gaps     []string `json:"gaps"`
}

type evaluationReport struct {
	OverallScore   int                  `json:"overallScore"`
	Recommendation string               `json:"recommendation"`
	Summary        string               `json:"summary"`
	Categories     []evaluationCategory `json:"categories"`
	Strengths      []string             `json:"strengths"`
	Risks          []string             `json:"risks"`
	Limitations    []string             `json:"limitations"`
}

type storedEvaluation struct {
	SessionID      string           `json:"sessionId"`
	SourceVersion  int              `json:"sourceVersion"`
	TranscriptHash string           `json:"transcriptHash"`
	CreatedAt      string           `json:"createdAt"`
	Report         evaluationReport `json:"report"`
}

var errPreparedInterviewNotFound = errors.New("prepared interview not found")
var errPreparedInterviewInvalid = errors.New("prepared interview is invalid")
var finalArtifactsWriteMu sync.Mutex
var evaluationResponsesURL = "https://api.openai.com/v1/responses"
var evaluationHTTPClient = &http.Client{Timeout: 65 * time.Second}
var realtimeTokenURL = "https://api.openai.com/v1/realtime/client_secrets"
var realtimeTokenHTTPClient = &http.Client{Timeout: 20 * time.Second}

// keyedLockTable serializes one key while permitting unrelated keys to proceed.
// Entries are removed once the holder and all waiters have left.
type keyedLockTable struct {
	mu      sync.Mutex
	entries map[string]*keyedLockEntry
}

type keyedLockEntry struct {
	mu   sync.Mutex
	refs int
}

func (table *keyedLockTable) lock(key string) func() {
	table.mu.Lock()
	if table.entries == nil {
		table.entries = map[string]*keyedLockEntry{}
	}
	entry := table.entries[key]
	if entry == nil {
		entry = &keyedLockEntry{}
		table.entries[key] = entry
	}
	entry.refs++
	table.mu.Unlock()

	entry.mu.Lock()
	return func() {
		entry.mu.Unlock()
		table.mu.Lock()
		entry.refs--
		if entry.refs == 0 && table.entries[key] == entry {
			delete(table.entries, key)
		}
		table.mu.Unlock()
	}
}

func (table *keyedLockTable) size() int {
	table.mu.Lock()
	defer table.mu.Unlock()
	return len(table.entries)
}

type jsonlStore struct{ mu sync.RWMutex }

var evidenceStore jsonlStore
var completionStore jsonlStore
var evaluationStore jsonlStore
var lifecycleLocks keyedLockTable

type evaluationValidationError struct {
	predicate string
}

func (err *evaluationValidationError) Error() string { return err.predicate }

const (
	evaluationPredicateDecode             = "judgment_decode"
	evaluationPredicateSummary            = "summary_required"
	evaluationPredicateRecommendation     = "recommendation_invalid"
	evaluationPredicateTopLevelArrays     = "top_level_arrays_required"
	evaluationPredicateCategoryCount      = "category_count_mismatch"
	evaluationPredicateCategoryUnknown    = "category_unknown"
	evaluationPredicateCategoryDuplicate  = "category_duplicate"
	evaluationPredicateCategoryScore      = "category_score_invalid"
	evaluationPredicateCategoryArrays     = "category_arrays_required"
	evaluationPredicateCategorySupport    = "category_support_required"
	evaluationPredicateResponseEnvelope   = "response_envelope_decode"
	evaluationPredicateOutputTextMissing  = "output_text_missing"
	evaluationInvalidProviderReportPublic = "evaluation model returned an invalid report; retry"
)

type serverOptions struct {
	address string
	devDir  string
}

func parseServerOptions(args []string, appAddress string) (serverOptions, error) {
	options := serverOptions{}
	address := strings.TrimSpace(appAddress)
	if address == "" {
		address = "127.0.0.1:8080"
	}
	flags := flag.NewFlagSet("local-interviewer", flag.ContinueOnError)
	flags.StringVar(&options.address, "addr", address, "HTTP listen address")
	flags.StringVar(&options.devDir, "dev-dir", "", "serve a frontend directory instead of embedded assets")
	if err := flags.Parse(args); err != nil {
		return serverOptions{}, err
	}
	return options, nil
}

func validateServerBind(address, apiKey string, unsafeNetworkBind bool) error {
	host, port, err := net.SplitHostPort(address)
	if err != nil || port == "" {
		return fmt.Errorf("APP_ADDR must include a host and port")
	}
	if _, err := net.LookupPort("tcp", port); err != nil {
		return fmt.Errorf("APP_ADDR has an invalid port")
	}
	if unsafeNetworkBind || isLoopbackHost(host) {
		return nil
	}
	_ = apiKey
	return fmt.Errorf("APP_ADDR must use a loopback host unless INTERVIEW_ALLOW_UNSAFE_NETWORK_BIND=true")
}

func isLoopbackHost(host string) bool {
	host = strings.TrimSpace(strings.Trim(host, "[]"))
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func unsafeNetworkBindEnabled() bool {
	value := strings.ToLower(strings.TrimSpace(os.Getenv("INTERVIEW_ALLOW_UNSAFE_NETWORK_BIND")))
	return value == "1" || value == "true" || value == "yes"
}

func displayURLForListenAddress(address string) string {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return (&url.URL{Scheme: "http", Host: address}).String()
	}
	if host == "" {
		host = "localhost"
	}
	return (&url.URL{Scheme: "http", Host: net.JoinHostPort(host, port)}).String()
}

func main() {
	if err := loadEnvFile(".env"); err != nil && !os.IsNotExist(err) {
		log.Printf("warning: could not load .env: %v", err)
	}
	options, err := parseServerOptions(os.Args[1:], os.Getenv("APP_ADDR"))
	if errors.Is(err, flag.ErrHelp) {
		return
	}
	if err != nil {
		log.Fatal(err)
	}
	if err := validateServerBind(options.address, os.Getenv("OPENAI_API_KEY"), unsafeNetworkBindEnabled()); err != nil {
		log.Fatal(err)
	}

	mux := http.NewServeMux()
	registerAPIHandlers(mux)

	var appFS fs.FS
	if options.devDir != "" {
		appFS = os.DirFS(options.devDir)
	} else {
		var err error
		appFS, err = fs.Sub(webAssets, "webdist")
		if err != nil {
			log.Fatal(err)
		}
	}
	mux.Handle("/", spaHandler(appFS))

	server := &http.Server{
		Addr:              options.address,
		Handler:           securityHeaders(mux),
		ReadHeaderTimeout: 5 * time.Second,
	}
	log.Printf("Local Interviewer running at %s", displayURLForListenAddress(options.address))
	log.Fatal(server.ListenAndServe())
}

func registerAPIHandlers(mux *http.ServeMux) {
	paid := newPaidRequestGuard(4, 30, time.Minute)
	mux.HandleFunc("/api/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(healthResponse{Status: "ok", Time: time.Now().UTC().Format(time.RFC3339)})
	})
	mux.HandleFunc("/api/realtime/token", protectAPIMutation(realtimeTokenHandler, paid))
	mux.HandleFunc("/api/openai/", protectAPIMutation(openAIProxyHandler, paid))
	mux.HandleFunc("/api/config", configHandler)
	mux.HandleFunc("/api/interview/setups", protectAPIMutation(interviewSetupsHandler, nil))
	mux.HandleFunc("/api/interview/setups/", protectAPIMutation(interviewSetupHandler, paid))
	mux.HandleFunc("/api/interview/uploads", protectAPIMutation(interviewUploadHandler, nil))
	mux.HandleFunc("/api/interview/evidence", protectAPIMutation(evidenceHandler, nil))
	mux.HandleFunc("/api/interview/complete", protectAPIMutation(completionHandler, nil))
	mux.HandleFunc("/api/interview/artifacts", protectAPIMutation(finalArtifactsHandler, nil))
	mux.HandleFunc("/api/interview/evaluate", protectAPIMutation(evaluationHandler, paid))
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) { http.NotFound(w, r) })
}

type paidRequestGuard struct {
	mu           sync.Mutex
	active       int
	starts       []time.Time
	maxActive    int
	maxPerWindow int
	window       time.Duration
	now          func() time.Time
}

func newPaidRequestGuard(maxActive, maxPerWindow int, window time.Duration) *paidRequestGuard {
	return &paidRequestGuard{maxActive: maxActive, maxPerWindow: maxPerWindow, window: window, now: time.Now}
}

func (guard *paidRequestGuard) acquire() (func(), bool) {
	now := guard.now()
	guard.mu.Lock()
	defer guard.mu.Unlock()
	cutoff := now.Add(-guard.window)
	kept := guard.starts[:0]
	for _, started := range guard.starts {
		if started.After(cutoff) {
			kept = append(kept, started)
		}
	}
	guard.starts = kept
	if guard.active >= guard.maxActive || len(guard.starts) >= guard.maxPerWindow {
		return nil, false
	}
	guard.active++
	guard.starts = append(guard.starts, now)
	return func() {
		guard.mu.Lock()
		guard.active--
		guard.mu.Unlock()
	}, true
}

func protectAPIMutation(next http.HandlerFunc, paid *paidRequestGuard) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if isMutatingMethod(r.Method) && !sameOriginOrNonBrowser(r) {
			http.Error(w, "cross-origin API request rejected", http.StatusForbidden)
			return
		}
		if paid != nil && isMutatingMethod(r.Method) {
			release, ok := paid.acquire()
			if !ok {
				w.Header().Set("Retry-After", "1")
				http.Error(w, "request limit reached; retry shortly", http.StatusTooManyRequests)
				return
			}
			defer release()
		}
		next(w, r)
	}
}

func isMutatingMethod(method string) bool {
	return method == http.MethodPost || method == http.MethodPut || method == http.MethodPatch || method == http.MethodDelete
}

func sameOriginOrNonBrowser(r *http.Request) bool {
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	if origin == "" {
		return true
	}
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return false
	}
	return strings.EqualFold(parsed.Host, r.Host)
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
	req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, realtimeTokenURL, bytes.NewReader(payload))
	if err != nil {
		http.Error(w, "could not create token request", http.StatusInternalServerError)
		return
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("OpenAI-Safety-Identifier", "local-interview-demo")
	response, err := realtimeTokenHTTPClient.Do(req)
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
		log.Printf("realtime token provider rejection status=%d", response.StatusCode)
		writeSafeProviderError(w, response.StatusCode, "realtime token")
		return
	}
	var token map[string]any
	if err := json.Unmarshal(body, &token); err != nil {
		http.Error(w, "Realtime token response was invalid", http.StatusBadGateway)
		return
	}
	token["model"] = model
	body, _ = json.Marshal(token)
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(body)
}

func writeSafeProviderError(w http.ResponseWriter, providerStatus int, operation string) {
	status := http.StatusBadGateway
	message := "AI provider is temporarily unavailable. Please retry."
	switch providerStatus {
	case http.StatusUnauthorized, http.StatusForbidden:
		message = "AI provider rejected the server credentials."
	case http.StatusTooManyRequests:
		status = http.StatusTooManyRequests
		message = "AI provider is busy. Please retry shortly."
	case http.StatusRequestTimeout, http.StatusGatewayTimeout:
		status = http.StatusGatewayTimeout
		message = "AI provider timed out. Please retry."
	}
	_ = operation
	http.Error(w, message, status)
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
	if !safeID.MatchString(event.SessionID) {
		http.Error(w, "sessionId must be a prepared setup id", http.StatusBadRequest)
		return
	}
	prepared, err := loadPreparedForSession(event.SessionID)
	if err != nil {
		writePreparedSessionError(w, err)
		return
	}
	if err := validateEvidenceEvent(event, prepared); err != nil {
		http.Error(w, err.Error(), http.StatusUnprocessableEntity)
		return
	}
	unlock := lifecycleLocks.lock(event.SessionID)
	defer unlock()
	completionStore.mu.RLock()
	_, completed, err := completionForSessionUnlocked("runtime/completions.jsonl", event.SessionID)
	completionStore.mu.RUnlock()
	if err != nil {
		http.Error(w, "could not read interview completion", http.StatusInternalServerError)
		return
	} else if completed {
		http.Error(w, "interview is already complete", http.StatusConflict)
		return
	}
	evidenceStore.mu.Lock()
	defer evidenceStore.mu.Unlock()
	existing, found, err := evidenceEventByIDUnlocked("runtime/evidence.jsonl", event.SessionID, event.EventID)
	if err != nil {
		http.Error(w, "could not read evidence", http.StatusInternalServerError)
		return
	}
	if found {
		if sameEvidenceEvent(existing, event) {
			writeJSON(w, http.StatusOK, map[string]bool{"saved": true})
			return
		}
		http.Error(w, "eventId already has different evidence", http.StatusConflict)
		return
	}
	event.CreatedAt = time.Now().UTC().Format(time.RFC3339Nano)
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
	if !safeID.MatchString(event.SessionID) {
		http.Error(w, "sessionId must be a prepared setup id", http.StatusBadRequest)
		return
	}
	prepared, err := loadPreparedForSession(event.SessionID)
	if err != nil {
		writePreparedSessionError(w, err)
		return
	}
	if err := validateCompletionEvent(event, prepared); err != nil {
		http.Error(w, err.Error(), http.StatusUnprocessableEntity)
		return
	}
	unlock := lifecycleLocks.lock(event.SessionID)
	defer unlock()
	if _, found, err := loadStoredFinalArtifacts(event.SessionID); err != nil {
		http.Error(w, "could not read final interview artifacts", http.StatusInternalServerError)
		return
	} else if !found {
		http.Error(w, "final interview artifacts are required before completion", http.StatusConflict)
		return
	}
	completionStore.mu.Lock()
	defer completionStore.mu.Unlock()
	existing, exists, err := completionForSessionUnlocked("runtime/completions.jsonl", event.SessionID)
	if err != nil {
		http.Error(w, "could not read interview completion", http.StatusInternalServerError)
		return
	}
	if exists {
		if !sameCompletionEvent(existing, event) {
			http.Error(w, "interview completion conflicts with the stored completion", http.StatusConflict)
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"completed": true})
		return
	}
	event.CreatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	if err := appendJSONLine("runtime/completions.jsonl", event); err != nil {
		http.Error(w, "could not complete interview", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"completed": true})
}

func finalArtifactsHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var input finalArtifactsRequest
	if err := decodeJSONLimit(w, r, &input, 8<<20); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if !safeID.MatchString(input.SessionID) {
		http.Error(w, "sessionId must be a prepared setup id", http.StatusBadRequest)
		return
	}
	prepared, err := loadPreparedForSession(input.SessionID)
	if err != nil {
		writePreparedSessionError(w, err)
		return
	}
	png, err := validateFinalArtifactsRequest(input)
	if err != nil {
		http.Error(w, err.Error(), http.StatusUnprocessableEntity)
		return
	}
	wanted := storedFinalArtifactsForRequest(input, prepared.Version, png)
	unlock := lifecycleLocks.lock(input.SessionID)
	defer unlock()
	completionStore.mu.RLock()
	_, completed, err := completionForSessionUnlocked("runtime/completions.jsonl", input.SessionID)
	completionStore.mu.RUnlock()
	if err != nil {
		http.Error(w, "could not read interview completion", http.StatusInternalServerError)
		return
	} else if completed {
		http.Error(w, "interview is already complete", http.StatusConflict)
		return
	}
	finalArtifactsWriteMu.Lock()
	defer finalArtifactsWriteMu.Unlock()
	existing, found, err := loadStoredFinalArtifacts(input.SessionID)
	if err != nil {
		http.Error(w, "could not read final interview artifacts", http.StatusInternalServerError)
		return
	}
	if found {
		if sameStoredFinalArtifacts(existing, wanted) {
			writeJSON(w, http.StatusOK, map[string]bool{"saved": true})
			return
		}
		http.Error(w, "final interview artifacts conflict with the stored artifacts", http.StatusConflict)
		return
	}
	wanted.CreatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	if err := saveFinalArtifacts(input, png, wanted); err != nil {
		http.Error(w, "could not save final interview artifacts", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]bool{"saved": true})
}

func evaluationHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var input evaluationRequest
	if err := decodeJSONLimit(w, r, &input, 8<<20); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if !safeID.MatchString(input.SessionID) {
		http.Error(w, "sessionId must be a prepared setup id", http.StatusBadRequest)
		return
	}
	if err := validateEvaluationRequest(input); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	prepared, err := loadPreparedForSession(input.SessionID)
	if err != nil {
		writePreparedSessionError(w, err)
		return
	}
	storedSetup, err := loadSetup(input.SessionID)
	if err != nil {
		http.Error(w, "could not read interview setup", http.StatusInternalServerError)
		return
	}
	transcriptJSON, err := json.Marshal(input.Transcript)
	if err != nil {
		http.Error(w, "could not encode transcript", http.StatusBadRequest)
		return
	}
	transcriptHash := artifactSHA256(transcriptJSON)
	unlock := lifecycleLocks.lock(input.SessionID)
	defer unlock()
	completionStore.mu.RLock()
	_, completed, err := completionForSessionUnlocked("runtime/completions.jsonl", input.SessionID)
	completionStore.mu.RUnlock()
	if err != nil {
		http.Error(w, "could not read interview completion", http.StatusInternalServerError)
		return
	} else if !completed {
		http.Error(w, "interview completion is required before evaluation", http.StatusConflict)
		return
	}
	// The lifecycle lock owns same-session idempotency while the provider runs.
	// Keep the shared JSONL lock limited to file scans and appends so unrelated
	// sessions can evaluate concurrently.
	evaluationStore.mu.RLock()
	if stored, found, err := storedEvaluationForSessionUnlocked("runtime/evaluations.jsonl", input.SessionID); err != nil {
		evaluationStore.mu.RUnlock()
		http.Error(w, "could not read stored evaluation", http.StatusInternalServerError)
		return
	} else if found {
		evaluationStore.mu.RUnlock()
		if stored.TranscriptHash != transcriptHash {
			http.Error(w, "evaluation conflicts with the stored transcript", http.StatusConflict)
			return
		}
		writeJSON(w, http.StatusOK, stored.Report)
		return
	}
	evaluationStore.mu.RUnlock()
	artifacts, err := loadImmutableArtifacts(input.SessionID, prepared.Version)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			http.Error(w, "final interview artifacts are required before evaluation", http.StatusConflict)
			return
		}
		http.Error(w, "stored final interview artifacts are invalid", http.StatusInternalServerError)
		return
	}
	apiKey := strings.TrimSpace(os.Getenv("OPENAI_API_KEY"))
	if apiKey == "" {
		http.Error(w, "OPENAI_API_KEY is not configured", http.StatusServiceUnavailable)
		return
	}
	evidenceStore.mu.RLock()
	evidence, err := evidenceForSessionUnlocked("runtime/evidence.jsonl", input.SessionID)
	evidenceStore.mu.RUnlock()
	if err != nil {
		http.Error(w, "could not read interview evidence", http.StatusInternalServerError)
		return
	}
	evidenceJSON, _ := json.Marshal(evidence)
	var transcript strings.Builder
	for _, turn := range input.Transcript {
		speaker := "Candidate"
		if turn.Role == "interviewer" {
			speaker = "Interviewer"
		}
		if text := strings.TrimSpace(turn.Text); text != "" {
			transcript.WriteString(speaker + ": " + text + "\n")
		}
	}
	transcriptSection := strings.TrimSpace(transcript.String())
	if transcriptSection == "" {
		transcriptSection = "(no transcript was captured)"
	}
	model := strings.TrimSpace(os.Getenv("OPENAI_EVALUATION_MODEL"))
	if model == "" {
		model = "gpt-5.6-terra"
	}
	rubricJSON, _ := json.Marshal(prepared.Rubric.Criteria)
	role := strings.TrimSpace(prepared.Role.Level + " " + prepared.Role.Title)
	prompt := fmt.Sprintf(`Evaluate this coding interview strictly from the supplied artifacts. Do not infer personality, confidence, or facts not present. Test execution results are included in the evidence below. Where tests were run, treat pass and fail counts as verified fact. Where the candidate never ran their code, note that as a gap. Award low scores when evidence is missing. Each category must cite concrete observations from the evidence, code, or whiteboard. Use the transcript as the primary evidence for communication and problem understanding. Quote the candidate's own words when citing communication evidence. If the transcript is empty, record that as an evidence gap rather than scoring communication from code alone.

Treat the whiteboard as supporting evidence of technical reasoning. Cite only visible labels, relationships, and candidate explanations. Do not infer intent from an ambiguous sketch. Do not penalize an empty whiteboard unless the rubric explicitly requires diagramming. A diagram does not prove that the code works. If code and diagram conflict, describe the conflict. In limitations, do not claim code was never executed when code_execution evidence shows tests were run.

Candidate: %s
Role: %s
Problem:
%s

Prepared rubric (server-owned metadata):
%s

Final code:
%s

Whiteboard scene summary (revision %d):
%s

Interview transcript:
%s

Recorded evidence JSON:
%s

Return exactly one judgment for every prepared rubric criterion. Use the criterion id only as its key. Return only id, score, evidence, and gaps for each category. Do not return category names, weights, or an overall score. The server owns that metadata and weighted arithmetic. Each category must include one or more specific evidence items or one or more specific gaps.`, storedSetup.Setup.Candidate.Name, role, prepared.Question.Prompt, rubricJSON, artifacts.Code, artifacts.Manifest.WhiteboardRevision, artifacts.Manifest.WhiteboardSummary, transcriptSection, evidenceJSON)
	schema := evaluationJudgmentSchema(prepared.Rubric.Criteria)
	content := []map[string]any{{"type": "input_text", "text": prompt}}
	if len(artifacts.WhiteboardPNG) > 0 {
		content = append(content, map[string]any{"type": "input_image", "image_url": "data:image/png;base64," + base64.StdEncoding.EncodeToString(artifacts.WhiteboardPNG), "detail": "high"})
	}
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	var report evaluationReport
	previousPredicate := ""
	for attempt := 0; attempt < 2; attempt++ {
		attemptContent := append([]map[string]any(nil), content...)
		if previousPredicate != "" {
			attemptContent = append(attemptContent, map[string]any{
				"type": "input_text",
				"text": "The previous judgment failed server validation (" + previousPredicate + "). Return a corrected complete judgment for the same prepared criterion IDs.",
			})
		}
		payload, err := json.Marshal(map[string]any{
			"model": model,
			"input": []map[string]any{{"role": "user", "content": attemptContent}},
			"text":  map[string]any{"format": map[string]any{"type": "json_schema", "name": "interview_evaluation", "strict": true, "schema": schema}},
		})
		if err != nil {
			http.Error(w, "could not create evaluation request", http.StatusInternalServerError)
			return
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, evaluationResponsesURL, bytes.NewReader(payload))
		if err != nil {
			http.Error(w, "could not create evaluation request", http.StatusInternalServerError)
			return
		}
		req.Header.Set("Authorization", "Bearer "+apiKey)
		req.Header.Set("Content-Type", "application/json")
		response, err := evaluationHTTPClient.Do(req)
		if err != nil {
			http.Error(w, "evaluation model is unreachable; retry", http.StatusBadGateway)
			return
		}
		body, readErr := io.ReadAll(io.LimitReader(response.Body, 2<<20))
		_ = response.Body.Close()
		if readErr != nil {
			http.Error(w, "could not read evaluation; retry", http.StatusBadGateway)
			return
		}
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			log.Printf("evaluation provider request rejected status=%d provider_request_id=%s",
				response.StatusCode, safeProviderLogID(response.Header.Get("x-request-id")))
			writeSafeProviderError(w, response.StatusCode, "evaluation")
			return
		}
		assembled, predicate, providerResponseID := evaluationReportFromProviderResponse(body, prepared.Rubric.Criteria)
		if predicate == "" {
			report = assembled
			break
		}
		logInvalidEvaluationReport(predicate, response.Header.Get("x-request-id"), providerResponseID)
		previousPredicate = predicate
		if attempt == 1 {
			http.Error(w, evaluationInvalidProviderReportPublic, http.StatusBadGateway)
			return
		}
	}
	evaluationStore.mu.Lock()
	defer evaluationStore.mu.Unlock()
	if stored, found, scanErr := storedEvaluationForSessionUnlocked("runtime/evaluations.jsonl", input.SessionID); scanErr != nil {
		http.Error(w, "could not read stored evaluation", http.StatusInternalServerError)
		return
	} else if found {
		if stored.TranscriptHash != transcriptHash {
			http.Error(w, "evaluation conflicts with the stored transcript", http.StatusConflict)
			return
		}
		writeJSON(w, http.StatusOK, stored.Report)
		return
	}
	err = appendJSONLine("runtime/evaluations.jsonl", storedEvaluation{SessionID: input.SessionID, SourceVersion: prepared.Version, TranscriptHash: transcriptHash, CreatedAt: time.Now().UTC().Format(time.RFC3339Nano), Report: report})
	if err != nil {
		http.Error(w, "could not save evaluation; retry", http.StatusServiceUnavailable)
		return
	}
	writeJSON(w, http.StatusOK, report)
}

func validateFinalArtifactsRequest(input finalArtifactsRequest) ([]byte, error) {
	if !input.codeRevisionSet {
		return nil, fmt.Errorf("codeRevision is required")
	}
	if input.CodeRevision < 0 {
		return nil, fmt.Errorf("codeRevision must be nonnegative")
	}
	if !input.codeSet {
		return nil, fmt.Errorf("code is required")
	}
	if !input.whiteboardRevisionSet {
		return nil, fmt.Errorf("whiteboardRevision is required")
	}
	if !input.whiteboardSummarySet {
		return nil, fmt.Errorf("whiteboardSummary is required")
	}
	return validateArtifactPayload(input.SessionID, input.Code, input.WhiteboardRevision, input.WhiteboardSummary, input.WhiteboardImage, input.WhiteboardScene)
}

func storedFinalArtifactsForRequest(input finalArtifactsRequest, sourceVersion int, png []byte) storedFinalArtifacts {
	return storedFinalArtifacts{
		SessionID:             input.SessionID,
		SourceVersion:         sourceVersion,
		CodeRevision:          input.CodeRevision,
		CodeSHA256:            artifactSHA256([]byte(input.Code)),
		WhiteboardRevision:    input.WhiteboardRevision,
		WhiteboardSummary:     input.WhiteboardSummary,
		WhiteboardSceneSHA256: artifactSHA256([]byte(input.WhiteboardScene)),
		WhiteboardPNGSHA256:   artifactSHA256(png),
	}
}

func artifactSHA256(content []byte) string {
	digest := sha256.Sum256(content)
	return fmt.Sprintf("%x", digest[:])
}

func sameStoredFinalArtifacts(left, right storedFinalArtifacts) bool {
	return left.SessionID == right.SessionID && left.SourceVersion == right.SourceVersion &&
		left.CodeRevision == right.CodeRevision && left.CodeSHA256 == right.CodeSHA256 &&
		left.WhiteboardRevision == right.WhiteboardRevision && left.WhiteboardSummary == right.WhiteboardSummary &&
		left.WhiteboardSceneSHA256 == right.WhiteboardSceneSHA256 && left.WhiteboardPNGSHA256 == right.WhiteboardPNGSHA256
}

func finalArtifactsDirectory(sessionID string) string {
	return filepath.Join("runtime", "artifacts", sessionID)
}

func loadStoredFinalArtifacts(sessionID string) (storedFinalArtifacts, bool, error) {
	var stored storedFinalArtifacts
	raw, err := os.ReadFile(filepath.Join(finalArtifactsDirectory(sessionID), "manifest.json"))
	if os.IsNotExist(err) {
		return stored, false, nil
	}
	if err != nil {
		return stored, false, err
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&stored); err != nil {
		return stored, false, err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return stored, false, fmt.Errorf("final artifact manifest contains multiple JSON values")
	}
	return stored, true, nil
}

func saveFinalArtifacts(input finalArtifactsRequest, png []byte, manifest storedFinalArtifacts) error {
	root := filepath.Join("runtime", "artifacts")
	if err := ensurePrivateRuntimeDirectory(root); err != nil {
		return err
	}
	name, err := safeArtifactName(input.SessionID)
	if err != nil {
		return err
	}
	temporary, err := os.MkdirTemp(root, "."+name+"-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(temporary)
	if err := os.WriteFile(filepath.Join(temporary, "code.txt"), []byte(input.Code), 0o600); err != nil {
		return err
	}
	if input.WhiteboardScene != "" {
		if err := os.WriteFile(filepath.Join(temporary, "whiteboard.tldr"), []byte(input.WhiteboardScene), 0o600); err != nil {
			return err
		}
	}
	if len(png) > 0 {
		if err := os.WriteFile(filepath.Join(temporary, "whiteboard.png"), png, 0o600); err != nil {
			return err
		}
	}
	if err := writePrivateJSONAtomic(filepath.Join(temporary, "manifest.json"), manifest); err != nil {
		return err
	}
	return os.Rename(temporary, finalArtifactsDirectory(name))
}

func evidenceForSession(path, sessionID string) ([]evidenceEvent, error) {
	evidenceStore.mu.RLock()
	defer evidenceStore.mu.RUnlock()
	return evidenceForSessionUnlocked(path, sessionID)
}

func evidenceForSessionUnlocked(path, sessionID string) ([]evidenceEvent, error) {
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

func evidenceEventByID(path, sessionID, eventID string) (evidenceEvent, bool, error) {
	evidenceStore.mu.RLock()
	defer evidenceStore.mu.RUnlock()
	return evidenceEventByIDUnlocked(path, sessionID, eventID)
}

func evidenceEventByIDUnlocked(path, sessionID, eventID string) (evidenceEvent, bool, error) {
	file, err := os.Open(path)
	if os.IsNotExist(err) {
		return evidenceEvent{}, false, nil
	}
	if err != nil {
		return evidenceEvent{}, false, err
	}
	defer file.Close()
	decoder := json.NewDecoder(file)
	for {
		var event evidenceEvent
		if err := decoder.Decode(&event); err == io.EOF {
			return evidenceEvent{}, false, nil
		} else if err != nil {
			return evidenceEvent{}, false, err
		}
		if event.SessionID == sessionID && event.EventID == eventID {
			return event, true, nil
		}
	}
}

func storedEvaluationForSession(path, sessionID string) (storedEvaluation, bool, error) {
	evaluationStore.mu.RLock()
	defer evaluationStore.mu.RUnlock()
	return storedEvaluationForSessionUnlocked(path, sessionID)
}

func storedEvaluationForSessionUnlocked(path, sessionID string) (storedEvaluation, bool, error) {
	file, err := os.Open(path)
	if os.IsNotExist(err) {
		return storedEvaluation{}, false, nil
	}
	if err != nil {
		return storedEvaluation{}, false, err
	}
	defer file.Close()
	decoder := json.NewDecoder(file)
	for {
		var stored storedEvaluation
		if err := decoder.Decode(&stored); err == io.EOF {
			return storedEvaluation{}, false, nil
		} else if err != nil {
			return storedEvaluation{}, false, err
		}
		if stored.SessionID == sessionID {
			return stored, true, nil
		}
	}
}

func sameEvidenceEvent(left, right evidenceEvent) bool {
	return left.SessionID == right.SessionID && left.EventID == right.EventID && left.Category == right.Category &&
		left.Observation == right.Observation && left.Confidence == right.Confidence && left.CodeRevision == right.CodeRevision &&
		left.WhiteboardRevision == right.WhiteboardRevision
}

func loadPreparedForSession(sessionID string) (preparedInterview, error) {
	prepared, err := loadPreparedInterview(sessionID)
	if os.IsNotExist(err) {
		return preparedInterview{}, errPreparedInterviewNotFound
	}
	if err != nil {
		return preparedInterview{}, err
	}
	setup, err := loadSetup(sessionID)
	if err != nil {
		return preparedInterview{}, err
	}
	if prepared.SetupID != sessionID || validatePreparedGuide(prepared, setup.Setup) != nil {
		return preparedInterview{}, errPreparedInterviewInvalid
	}
	return prepared, nil
}

func writePreparedSessionError(w http.ResponseWriter, err error) {
	if errors.Is(err, errPreparedInterviewNotFound) {
		http.Error(w, "prepared interview not found", http.StatusUnprocessableEntity)
		return
	}
	if errors.Is(err, errPreparedInterviewInvalid) {
		http.Error(w, "prepared interview is invalid", http.StatusInternalServerError)
		return
	}
	http.Error(w, "could not read prepared interview", http.StatusInternalServerError)
}

func validateEvidenceEvent(event evidenceEvent, prepared preparedInterview) error {
	if !safeID.MatchString(event.EventID) {
		return fmt.Errorf("eventId must be a 32-character lowercase hexadecimal id")
	}
	if err := requiredText("observation", event.Observation, 10000); err != nil {
		return err
	}
	if !event.confidenceSet {
		return fmt.Errorf("confidence is required")
	}
	if event.Confidence < 0 || event.Confidence > 1 {
		return fmt.Errorf("confidence must be between 0 and 1")
	}
	if !event.codeRevisionSet {
		return fmt.Errorf("codeRevision is required")
	}
	if event.CodeRevision < 0 {
		return fmt.Errorf("codeRevision must be nonnegative")
	}
	if !event.whiteboardRevisionSet {
		return fmt.Errorf("whiteboardRevision is required")
	}
	if event.WhiteboardRevision < 0 {
		return fmt.Errorf("whiteboardRevision must be nonnegative")
	}
	if event.Category != "code_execution" {
		found := false
		for _, criterion := range prepared.Rubric.Criteria {
			if event.Category == criterion.ID {
				found = true
				break
			}
		}
		if !found {
			return fmt.Errorf("category is not part of the prepared rubric")
		}
	}
	return nil
}

func validateCompletionEvent(event completionEvent, prepared preparedInterview) error {
	if event.Reason != "time_limit" && event.Reason != "manual" {
		return fmt.Errorf("reason must be time_limit or manual")
	}
	if event.Elapsed < 0 || event.Elapsed > prepared.Interview.DurationSeconds {
		return fmt.Errorf("elapsedSeconds is outside the interview duration")
	}
	return nil
}

func sameCompletionEvent(left, right completionEvent) bool {
	return left.SessionID == right.SessionID && left.Reason == right.Reason && left.Elapsed == right.Elapsed
}

func completionForSession(path, sessionID string) (completionEvent, bool, error) {
	completionStore.mu.RLock()
	defer completionStore.mu.RUnlock()
	return completionForSessionUnlocked(path, sessionID)
}

func completionForSessionUnlocked(path, sessionID string) (completionEvent, bool, error) {
	file, err := os.Open(path)
	if os.IsNotExist(err) {
		return completionEvent{}, false, nil
	}
	if err != nil {
		return completionEvent{}, false, err
	}
	defer file.Close()
	decoder := json.NewDecoder(file)
	for {
		var event completionEvent
		if err := decoder.Decode(&event); err == io.EOF {
			return completionEvent{}, false, nil
		} else if err != nil {
			return completionEvent{}, false, err
		}
		if event.SessionID == sessionID {
			return event, true, nil
		}
	}
}

func validateEvaluationRequest(input evaluationRequest) error {
	if !input.transcriptSet {
		return fmt.Errorf("transcript is required")
	}
	if len(input.Transcript) > 1000 {
		return fmt.Errorf("transcript contains too many turns")
	}
	for _, turn := range input.Transcript {
		if turn.Role != "candidate" && turn.Role != "interviewer" {
			return fmt.Errorf("transcript role is invalid")
		}
		if len(turn.Text) > 10000 {
			return fmt.Errorf("transcript turn exceeds the size limit")
		}
	}
	return nil
}

func validateArtifactPayload(sessionID, code string, whiteboardRevision int, whiteboardSummary, whiteboardImage, whiteboardScene string) ([]byte, error) {
	if _, err := safeArtifactName(sessionID); err != nil {
		return nil, err
	}
	if whiteboardRevision < 0 {
		return nil, fmt.Errorf("whiteboardRevision must be nonnegative")
	}
	if len(code) > 200000 || len(whiteboardSummary) > 100000 || len(whiteboardScene) > 2<<20 {
		return nil, fmt.Errorf("evaluation artifact exceeds its size limit")
	}
	png, err := decodeWhiteboardPNG(whiteboardImage)
	if err != nil {
		return nil, err
	}
	if whiteboardScene != "" && !json.Valid([]byte(whiteboardScene)) {
		return nil, fmt.Errorf("whiteboardScene is not valid JSON")
	}
	return png, nil
}

type immutableArtifacts struct {
	Manifest      storedFinalArtifacts
	Code          string
	WhiteboardPNG []byte
}

func loadImmutableArtifacts(sessionID string, sourceVersion int) (immutableArtifacts, error) {
	manifest, found, err := loadStoredFinalArtifacts(sessionID)
	if err != nil {
		return immutableArtifacts{}, err
	}
	if !found {
		return immutableArtifacts{}, os.ErrNotExist
	}
	if manifest.SessionID != sessionID || manifest.SourceVersion != sourceVersion || manifest.CodeRevision < 0 || manifest.WhiteboardRevision < 0 {
		return immutableArtifacts{}, fmt.Errorf("artifact manifest is invalid")
	}
	directory := finalArtifactsDirectory(sessionID)
	code, err := os.ReadFile(filepath.Join(directory, "code.txt"))
	if err != nil {
		return immutableArtifacts{}, err
	}
	if len(code) > 200000 || artifactSHA256(code) != manifest.CodeSHA256 {
		return immutableArtifacts{}, fmt.Errorf("stored code is invalid")
	}
	scene, err := readOptionalArtifact(filepath.Join(directory, "whiteboard.tldr"), 2<<20)
	if err != nil {
		return immutableArtifacts{}, err
	}
	if artifactSHA256(scene) != manifest.WhiteboardSceneSHA256 {
		return immutableArtifacts{}, fmt.Errorf("stored whiteboard scene is invalid")
	}
	png, err := readOptionalArtifact(filepath.Join(directory, "whiteboard.png"), 5<<20)
	if err != nil {
		return immutableArtifacts{}, err
	}
	if artifactSHA256(png) != manifest.WhiteboardPNGSHA256 {
		return immutableArtifacts{}, fmt.Errorf("stored whiteboard image is invalid")
	}
	return immutableArtifacts{Manifest: manifest, Code: string(code), WhiteboardPNG: png}, nil
}

func readOptionalArtifact(path string, maximum int) ([]byte, error) {
	content, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return []byte{}, nil
	}
	if err != nil {
		return nil, err
	}
	if len(content) > maximum {
		return nil, fmt.Errorf("stored artifact exceeds its size limit")
	}
	return content, nil
}

func evaluationJudgmentSchema(criteria []rubricCriterion) map[string]any {
	categoryIDs := make([]string, 0, len(criteria))
	for _, criterion := range criteria {
		categoryIDs = append(categoryIDs, criterion.ID)
	}
	return map[string]any{
		"type": "object", "additionalProperties": false,
		"properties": map[string]any{
			"recommendation": map[string]any{"type": "string", "enum": []string{"strong_hire", "hire", "mixed", "no_hire", "insufficient_evidence"}},
			"summary":        map[string]any{"type": "string"},
			"categories": map[string]any{
				"type": "array", "minItems": len(criteria), "maxItems": len(criteria),
				"items": map[string]any{
					"type": "object", "additionalProperties": false,
					"properties": map[string]any{
						"id":       map[string]any{"type": "string", "enum": categoryIDs},
						"score":    map[string]any{"type": "integer", "minimum": 0, "maximum": 100},
						"evidence": map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
						"gaps":     map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
					},
					"required": []string{"id", "score", "evidence", "gaps"},
				},
			},
			"strengths":   map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
			"risks":       map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
			"limitations": map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
		},
		"required": []string{"recommendation", "summary", "categories", "strengths", "risks", "limitations"},
	}
}

func evaluationOutputText(result responseAPIResult) (string, bool) {
	for _, item := range result.Output {
		for _, content := range item.Content {
			if content.Type == "output_text" {
				return content.Text, true
			}
		}
	}
	return "", false
}

func evaluationReportFromProviderResponse(body []byte, criteria []rubricCriterion) (evaluationReport, string, string) {
	var result responseAPIResult
	if err := json.Unmarshal(body, &result); err != nil {
		return evaluationReport{}, evaluationPredicateResponseEnvelope, ""
	}
	judgmentText, ok := evaluationOutputText(result)
	if !ok {
		return evaluationReport{}, evaluationPredicateOutputTextMissing, result.ID
	}
	judgment, err := decodeEvaluationJudgment([]byte(judgmentText))
	if err != nil {
		return evaluationReport{}, evaluationPredicateDecode, result.ID
	}
	report, err := assembleEvaluationReport(judgment, criteria)
	if err != nil {
		return evaluationReport{}, evaluationValidationPredicate(err), result.ID
	}
	return report, "", result.ID
}

func decodeEvaluationJudgment(raw []byte) (evaluationJudgment, error) {
	var judgment evaluationJudgment
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&judgment); err != nil {
		return evaluationJudgment{}, err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return evaluationJudgment{}, fmt.Errorf("multiple JSON values")
	}
	return judgment, nil
}

func assembleEvaluationReport(judgment evaluationJudgment, criteria []rubricCriterion) (evaluationReport, error) {
	if err := validateEvaluationJudgment(judgment, criteria); err != nil {
		return evaluationReport{}, err
	}
	byID := make(map[string]evaluationCategoryJudgment, len(judgment.Categories))
	for _, category := range judgment.Categories {
		byID[category.ID] = category
	}
	categories := make([]evaluationCategory, 0, len(criteria))
	for _, criterion := range criteria {
		judgmentCategory := byID[criterion.ID]
		categories = append(categories, evaluationCategory{
			ID:       criterion.ID,
			Name:     criterion.Name,
			Score:    *judgmentCategory.Score,
			Weight:   criterion.Weight,
			Evidence: append([]string{}, judgmentCategory.Evidence...),
			Gaps:     append([]string{}, judgmentCategory.Gaps...),
		})
	}
	return evaluationReport{
		OverallScore:   weightedOverallScore(categories),
		Recommendation: judgment.Recommendation,
		Summary:        judgment.Summary,
		Categories:     categories,
		Strengths:      append([]string{}, judgment.Strengths...),
		Risks:          append([]string{}, judgment.Risks...),
		Limitations:    append([]string{}, judgment.Limitations...),
	}, nil
}

func validateEvaluationJudgment(judgment evaluationJudgment, criteria []rubricCriterion) error {
	if strings.TrimSpace(judgment.Summary) == "" {
		return &evaluationValidationError{predicate: evaluationPredicateSummary}
	}
	if judgment.Recommendation != "strong_hire" && judgment.Recommendation != "hire" && judgment.Recommendation != "mixed" && judgment.Recommendation != "no_hire" && judgment.Recommendation != "insufficient_evidence" {
		return &evaluationValidationError{predicate: evaluationPredicateRecommendation}
	}
	if judgment.Strengths == nil || judgment.Risks == nil || judgment.Limitations == nil {
		return &evaluationValidationError{predicate: evaluationPredicateTopLevelArrays}
	}
	if len(judgment.Categories) != len(criteria) {
		return &evaluationValidationError{predicate: evaluationPredicateCategoryCount}
	}
	allowed := make(map[string]bool, len(criteria))
	for _, criterion := range criteria {
		allowed[criterion.ID] = true
	}
	seen := make(map[string]bool, len(criteria))
	for _, category := range judgment.Categories {
		if !allowed[category.ID] {
			return &evaluationValidationError{predicate: evaluationPredicateCategoryUnknown}
		}
		if seen[category.ID] {
			return &evaluationValidationError{predicate: evaluationPredicateCategoryDuplicate}
		}
		seen[category.ID] = true
		if category.Score == nil || *category.Score < 0 || *category.Score > 100 {
			return &evaluationValidationError{predicate: evaluationPredicateCategoryScore}
		}
		if category.Evidence == nil || category.Gaps == nil {
			return &evaluationValidationError{predicate: evaluationPredicateCategoryArrays}
		}
		if !hasMeaningfulText(category.Evidence) && !hasMeaningfulText(category.Gaps) {
			return &evaluationValidationError{predicate: evaluationPredicateCategorySupport}
		}
	}
	return nil
}

// weightedOverallScore uses the prepared integer weights. It rounds the
// weighted sum to the nearest whole point, with an exact half point rounding up.
func weightedOverallScore(categories []evaluationCategory) int {
	numerator := 0
	for _, category := range categories {
		numerator += category.Score * category.Weight
	}
	return (numerator + 50) / 100
}

func evaluationValidationPredicate(err error) string {
	var validationErr *evaluationValidationError
	if errors.As(err, &validationErr) {
		return validationErr.predicate
	}
	return "validation_internal"
}

func safeProviderLogID(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return "missing"
	}
	if len(value) > 128 {
		return "invalid"
	}
	for _, character := range value {
		if (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') || (character >= '0' && character <= '9') || character == '-' || character == '_' || character == '.' || character == ':' {
			continue
		}
		return "invalid"
	}
	return value
}

func logInvalidEvaluationReport(predicate, providerRequestID, providerResponseID string) {
	log.Printf("evaluation provider report invalid predicate=%s provider_request_id=%s provider_response_id=%s",
		predicate, safeProviderLogID(providerRequestID), safeProviderLogID(providerResponseID))
}

func hasMeaningfulText(items []string) bool {
	for _, item := range items {
		value := strings.ToLower(strings.TrimSpace(item))
		if len(value) >= 3 && value != "n/a" && value != "na" && value != "???" && value != "unknown" && value != "none" {
			return true
		}
	}
	return false
}

func decodeJSON(w http.ResponseWriter, r *http.Request, target any) error {
	return decodeJSONLimit(w, r, target, 128<<10)
}

func decodeJSONLimit(w http.ResponseWriter, r *http.Request, target any, limit int64) error {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, limit))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return fmt.Errorf("invalid JSON request")
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return fmt.Errorf("invalid JSON request")
	}
	return nil
}

func decodeWhiteboardPNG(dataURL string) ([]byte, error) {
	if dataURL == "" {
		return nil, nil
	}
	const prefix = "data:image/png;base64,"
	if !strings.HasPrefix(dataURL, prefix) {
		return nil, fmt.Errorf("whiteboardImage must be a PNG data URL")
	}
	decoded, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(dataURL, prefix))
	if err != nil || len(decoded) < 8 || !bytes.Equal(decoded[:8], []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}) {
		return nil, fmt.Errorf("whiteboardImage is not a valid PNG")
	}
	if len(decoded) > 5<<20 {
		return nil, fmt.Errorf("whiteboardImage exceeds the 5 MB limit")
	}
	return decoded, nil
}

func safeArtifactName(value string) (string, error) {
	if value == "" {
		return "", fmt.Errorf("sessionId is required")
	}
	for _, character := range value {
		if (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') || (character >= '0' && character <= '9') || character == '-' || character == '_' {
			continue
		}
		return "", fmt.Errorf("sessionId contains unsupported characters")
	}
	return value, nil
}

func appendJSONLine(path string, value any) error {
	if err := ensurePrivateRuntimeDirectory(filepath.Dir(path)); err != nil {
		return err
	}
	if info, err := os.Lstat(path); err == nil {
		if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
			return fmt.Errorf("runtime file is not a regular file")
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer file.Close()
	if err := file.Chmod(0o600); err != nil {
		return err
	}
	return json.NewEncoder(file).Encode(value)
}

func ensurePrivateRuntimeDirectory(path string) error {
	clean := filepath.Clean(path)
	if clean != "runtime" && !strings.HasPrefix(clean, "runtime"+string(os.PathSeparator)) {
		return fmt.Errorf("runtime path is invalid")
	}
	relative, err := filepath.Rel("runtime", clean)
	if err != nil {
		return err
	}
	current := "runtime"
	components := []string{"runtime"}
	if relative != "." {
		components = append(components, strings.Split(relative, string(os.PathSeparator))...)
	}
	for index, part := range components {
		if index > 0 {
			current = filepath.Join(current, part)
		}
		info, err := os.Lstat(current)
		if os.IsNotExist(err) {
			if err := os.Mkdir(current, 0o700); err != nil && !os.IsExist(err) {
				return err
			}
			info, err = os.Lstat(current)
		}
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("runtime path contains a symlink")
		}
		if !info.IsDir() {
			return fmt.Errorf("runtime path component is not a directory")
		}
		if err := os.Chmod(current, 0o700); err != nil {
			return err
		}
	}
	return nil
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
