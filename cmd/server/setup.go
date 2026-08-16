package main

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	setupVersion          = 1
	maxSetupRequestBytes  = 256 << 10
	maxUploadBytes        = 10 << 20
	setupStorageDirectory = "runtime/setups"
)

var safeID = regexp.MustCompile(`^[a-f0-9]{32}$`)

var errSetupExists = errors.New("interview setup already exists")

const candidateContextPolicy = "job_related_question_tailoring_only"

var allowedInterviewTypes = map[string]bool{"coding": true, "system_design": true, "behavioral": true, "mixed": true}
var allowedUploadExtensions = map[string]bool{".pdf": true, ".txt": true, ".md": true, ".json": true, ".docx": true}

// interviewSetup is the versioned hand-off from setup to the interview layer.
// The browser owns draft state. This object is a validated snapshot.
type interviewSetup struct {
	SetupID                string         `json:"setupId"`
	Version                int            `json:"version"`
	CandidateContextPolicy string         `json:"candidateContextPolicy"`
	Candidate              setupCandidate `json:"candidate"`
	Role                   setupRole      `json:"role"`
	Interview              setupInterview `json:"interview"`
	Brief                  setupBrief     `json:"brief"`
	Rubric                 setupRubric    `json:"rubric"`
}

type setupCandidate struct {
	Name          string            `json:"name"`
	Sources       []candidateSource `json:"sources"`
	ReviewedFacts []string          `json:"reviewedFacts"`
}

type candidateSource struct {
	Type      string `json:"type"`
	Reference string `json:"reference"`
}

type setupRole struct {
	Title string `json:"title"`
	Level string `json:"level"`
}

type setupInterview struct {
	Type            string   `json:"type"`
	DurationSeconds int      `json:"durationSeconds"`
	CodingLanguage  string   `json:"codingLanguage,omitempty"`
	QuestionTypes   []string `json:"questionTypes"`
	Workspaces      []string `json:"workspaces"`
	Tools           []string `json:"tools"`
	Channels        []string `json:"channels"`
}

type setupBrief struct {
	Text          string   `json:"text"`
	AttachmentIDs []string `json:"attachmentIds,omitempty"`
}

type setupRubric struct {
	Criteria      []rubricCriterion `json:"criteria"`
	SourceText    string            `json:"sourceText"`
	AttachmentIDs []string          `json:"attachmentIds"`
}

type rubricCriterion struct {
	ID               string `json:"id"`
	Name             string `json:"name"`
	Weight           int    `json:"weight"`
	ExpectedEvidence string `json:"expectedEvidence"`
}

type storedInterviewSetup struct {
	ID        string         `json:"id"`
	CreatedAt string         `json:"createdAt"`
	Setup     interviewSetup `json:"setup"`
}

type uploadedInterviewFile struct {
	ID                  string `json:"id"`
	SetupID             string `json:"setupId"`
	CreatedAt           string `json:"createdAt"`
	Kind                string `json:"kind"`
	CandidateSourceType string `json:"candidateSourceType,omitempty"`
	OriginalName        string `json:"originalName"`
	ContentType         string `json:"contentType"`
	SizeBytes           int64  `json:"sizeBytes"`
}

func interviewSetupsHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var setup interviewSetup
	if err := decodeJSONLimit(w, r, &setup, maxSetupRequestBytes); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err := normalizeInterviewSetup(&setup); err != nil {
		http.Error(w, err.Error(), http.StatusUnprocessableEntity)
		return
	}
	if err := validateInterviewSetup(setup); err != nil {
		http.Error(w, err.Error(), http.StatusUnprocessableEntity)
		return
	}
	stored := storedInterviewSetup{ID: setup.SetupID, CreatedAt: time.Now().UTC().Format(time.RFC3339Nano), Setup: setup}
	if err := saveSetup(stored); err != nil {
		if errors.Is(err, errSetupExists) {
			existing, loadErr := loadSetup(setup.SetupID)
			if loadErr == nil && sameInterviewSetup(existing.Setup, setup) {
				writeJSON(w, http.StatusOK, existing)
				return
			}
			http.Error(w, "a different interview setup already uses this setup id", http.StatusConflict)
			return
		}
		http.Error(w, "could not save interview setup", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusCreated, stored)
}

func sameInterviewSetup(left, right interviewSetup) bool {
	leftJSON, leftErr := json.Marshal(left)
	rightJSON, rightErr := json.Marshal(right)
	return leftErr == nil && rightErr == nil && bytes.Equal(leftJSON, rightJSON)
}

func interviewSetupHandler(w http.ResponseWriter, r *http.Request) {
	path := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/interview/setups/"), "/")
	parts := strings.Split(path, "/")
	if len(parts) == 2 && parts[1] == "prepare" {
		interviewPreparationHandler(w, r, parts[0])
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if len(parts) != 1 || !safeID.MatchString(parts[0]) {
		http.Error(w, "invalid setup id", http.StatusBadRequest)
		return
	}
	stored, err := loadSetup(parts[0])
	if errors.Is(err, os.ErrNotExist) {
		http.Error(w, "interview setup not found", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, "could not read interview setup", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, stored)
}

func interviewUploadHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadBytes+(1<<20))
	if err := r.ParseMultipartForm(maxUploadBytes); err != nil {
		http.Error(w, "invalid upload; files must be 10 MB or smaller", http.StatusBadRequest)
		return
	}
	kind := strings.TrimSpace(r.FormValue("kind"))
	if kind != "brief" && kind != "rubric" && kind != "candidate" {
		http.Error(w, "kind must be brief, rubric, or candidate", http.StatusUnprocessableEntity)
		return
	}
	sourceType := strings.TrimSpace(r.FormValue("candidateSourceType"))
	setupID := strings.TrimSpace(r.FormValue("setupId"))
	if !safeID.MatchString(setupID) {
		http.Error(w, "setupId must be a 32-character lowercase hexadecimal id", http.StatusUnprocessableEntity)
		return
	}
	if kind == "candidate" && sourceType != "resume" {
		http.Error(w, "candidateSourceType must be resume for candidate uploads", http.StatusUnprocessableEntity)
		return
	}
	if kind != "candidate" && sourceType != "" {
		http.Error(w, "candidateSourceType is only valid for candidate uploads", http.StatusUnprocessableEntity)
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		http.Error(w, "file is required", http.StatusBadRequest)
		return
	}
	defer file.Close()
	name := filepath.Base(header.Filename)
	if name == "." || name == "" || len(name) > 255 {
		http.Error(w, "file name is invalid", http.StatusUnprocessableEntity)
		return
	}
	extension := strings.ToLower(filepath.Ext(name))
	if !allowedUploadExtensions[extension] {
		http.Error(w, "file type is not allowed", http.StatusUnprocessableEntity)
		return
	}
	id, err := newOpaqueID()
	if err != nil {
		http.Error(w, "could not create upload id", http.StatusInternalServerError)
		return
	}
	directory := uploadDirectory(setupID)
	if err := ensurePrivateRuntimeDirectory(directory); err != nil {
		http.Error(w, "could not store upload", http.StatusInternalServerError)
		return
	}
	destination, err := os.OpenFile(filepath.Join(directory, id+safeUploadExtension(name)), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		http.Error(w, "could not store upload", http.StatusInternalServerError)
		return
	}
	prefix, prefixErr := io.ReadAll(io.LimitReader(file, 512))
	size, copyErr := io.Copy(destination, io.LimitReader(io.MultiReader(bytes.NewReader(prefix), file), maxUploadBytes+1))
	closeErr := destination.Close()
	if prefixErr != nil || copyErr != nil || closeErr != nil || size > maxUploadBytes {
		_ = os.Remove(destination.Name())
		http.Error(w, "could not store upload; files must be 10 MB or smaller", http.StatusBadRequest)
		return
	}
	if size == 0 {
		_ = os.Remove(destination.Name())
		http.Error(w, "file must not be empty", http.StatusUnprocessableEntity)
		return
	}
	content, readErr := os.ReadFile(destination.Name())
	contentType, err := canonicalUploadContentType(extension, content)
	if readErr != nil {
		err = readErr
	}
	if err != nil {
		_ = os.Remove(destination.Name())
		http.Error(w, "file content does not match its extension", http.StatusUnprocessableEntity)
		return
	}
	metadata := uploadedInterviewFile{ID: id, SetupID: setupID, CreatedAt: time.Now().UTC().Format(time.RFC3339Nano), Kind: kind, CandidateSourceType: sourceType, OriginalName: name, ContentType: contentType, SizeBytes: size}
	if err := writePrivateJSONAtomic(filepath.Join(directory, id+".json"), metadata); err != nil {
		_ = os.Remove(destination.Name())
		http.Error(w, "could not store upload metadata", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusCreated, metadata)
}

func validateInterviewSetup(setup interviewSetup) error {
	if !safeID.MatchString(setup.SetupID) {
		return fmt.Errorf("setupId must be a 32-character lowercase hexadecimal id")
	}
	if setup.Version != setupVersion {
		return fmt.Errorf("version must be %d", setupVersion)
	}
	if setup.CandidateContextPolicy != candidateContextPolicy {
		return fmt.Errorf("candidateContextPolicy must be %q", candidateContextPolicy)
	}
	if err := requiredText("candidate.name", setup.Candidate.Name, 200); err != nil {
		return err
	}
	if len(setup.Candidate.Sources) > 10 || len(setup.Candidate.ReviewedFacts) > 50 {
		return fmt.Errorf("candidate has too many sources or reviewed facts")
	}
	for index, source := range setup.Candidate.Sources {
		if !isCandidateSourceType(source.Type) {
			return fmt.Errorf("candidate.sources[%d].type is invalid", index)
		}
		if !validCandidateSourceReference(source) {
			return fmt.Errorf("candidate.sources[%d].reference is invalid", index)
		}
		if strings.HasPrefix(source.Reference, "upload:") {
			if err := validateUploadedFile(setup.SetupID, strings.TrimPrefix(source.Reference, "upload:"), "candidate", "resume"); err != nil {
				return fmt.Errorf("candidate.sources[%d].reference is invalid", index)
			}
		}
	}
	for index, fact := range setup.Candidate.ReviewedFacts {
		if err := requiredText(fmt.Sprintf("candidate.reviewedFacts[%d]", index), fact, 2000); err != nil {
			return err
		}
	}
	if err := optionalText("role.title", setup.Role.Title, 200); err != nil {
		return err
	}
	if err := optionalText("role.level", setup.Role.Level, 100); err != nil {
		return err
	}
	if err := requiredText("interview.type", setup.Interview.Type, 100); err != nil {
		return err
	}
	if !allowedInterviewTypes[setup.Interview.Type] {
		return fmt.Errorf("interview.type is invalid")
	}
	if setup.Interview.DurationSeconds < 60 || setup.Interview.DurationSeconds > 7200 {
		return fmt.Errorf("interview.durationSeconds must be between 60 and 7200")
	}
	if setup.Interview.CodingLanguage != "" {
		if err := requiredText("interview.codingLanguage", setup.Interview.CodingLanguage, 100); err != nil {
			return err
		}
	}
	if containsText(setup.Interview.Workspaces, "code_editor") && setup.Interview.CodingLanguage != "" && !strings.EqualFold(strings.TrimSpace(setup.Interview.CodingLanguage), "typescript") {
		return fmt.Errorf("interview.codingLanguage must be TypeScript when code_editor is enabled")
	}
	if err := uniqueTextList("interview.questionTypes", setup.Interview.QuestionTypes, 0, 10, 100); err != nil {
		return err
	}
	if err := allowedTextList("interview.workspaces", setup.Interview.Workspaces, []string{"code_editor", "whiteboard"}, 0); err != nil {
		return err
	}
	if len(setup.Interview.Tools) != 0 {
		return fmt.Errorf("interview.tools must be empty; AI chat is not available")
	}
	if err := allowedTextList("interview.channels", setup.Interview.Channels, []string{"voice"}, 1); err != nil {
		return err
	}
	if len(setup.Brief.Text) > 100000 {
		return fmt.Errorf("brief.text exceeds the 100 KB limit")
	}
	if err := attachmentIDsValid(setup.SetupID, "brief.attachmentIds", setup.Brief.AttachmentIDs, "brief"); err != nil {
		return err
	}
	if len(setup.Rubric.SourceText) > 100000 {
		return fmt.Errorf("rubric.sourceText exceeds the 100 KB limit")
	}
	if len(setup.Rubric.Criteria) > 20 {
		return fmt.Errorf("rubric.criteria must contain at most 20 criteria")
	}
	weights, ids := 0, map[string]bool{}
	for index, criterion := range setup.Rubric.Criteria {
		if err := requiredText(fmt.Sprintf("rubric.criteria[%d].id", index), criterion.ID, 100); err != nil {
			return err
		}
		key := canonicalRubricID(criterion.ID)
		if ids[key] {
			return fmt.Errorf("rubric.criteria contains duplicate id %q", criterion.ID)
		}
		ids[key] = true
		if err := requiredText(fmt.Sprintf("rubric.criteria[%d].name", index), criterion.Name, 200); err != nil {
			return err
		}
		if err := requiredText(fmt.Sprintf("rubric.criteria[%d].expectedEvidence", index), criterion.ExpectedEvidence, 2000); err != nil {
			return err
		}
		if criterion.Weight < 1 || criterion.Weight > 100 {
			return fmt.Errorf("rubric.criteria[%d].weight must be between 1 and 100", index)
		}
		weights += criterion.Weight
	}
	if len(setup.Rubric.Criteria) > 0 && weights != 100 {
		return fmt.Errorf("rubric.criteria weights must total 100")
	}
	return attachmentIDsValid(setup.SetupID, "rubric.attachmentIds", setup.Rubric.AttachmentIDs, "rubric")
}

func canonicalRubricID(id string) string {
	return strings.ToLower(strings.TrimSpace(id))
}

// normalizeInterviewSetup creates the one canonical rubric identifier form that
// every later guide, evidence, and evaluation boundary uses.
func normalizeInterviewSetup(setup *interviewSetup) error {
	seen := make(map[string]bool, len(setup.Rubric.Criteria))
	for index := range setup.Rubric.Criteria {
		id := canonicalRubricID(setup.Rubric.Criteria[index].ID)
		if id != "" && seen[id] {
			return fmt.Errorf("rubric.criteria contains duplicate id %q", setup.Rubric.Criteria[index].ID)
		}
		if id != "" {
			seen[id] = true
		}
		setup.Rubric.Criteria[index].ID = id
	}
	return nil
}

func optionalText(field, value string, maximum int) error {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return requiredText(field, value, maximum)
}

func requiredText(field, value string, maximum int) error {
	if strings.TrimSpace(value) == "" {
		return fmt.Errorf("%s is required", field)
	}
	if len(value) > maximum {
		return fmt.Errorf("%s exceeds the limit of %d characters", field, maximum)
	}
	return nil
}
func isCandidateSourceType(value string) bool {
	return value == "resume" || value == "linkedin" || value == "github" || value == "website"
}
func validCandidateSourceReference(source candidateSource) bool {
	if source.Type == "resume" && strings.HasPrefix(source.Reference, "upload:") {
		return safeID.MatchString(strings.TrimPrefix(source.Reference, "upload:"))
	}
	if source.Type == "resume" {
		return false
	}
	parsed, err := url.ParseRequestURI(source.Reference)
	return err == nil && parsed.Scheme == "https" && parsed.Host != ""
}

func canonicalUploadContentType(extension string, prefix []byte) (string, error) {
	switch extension {
	case ".pdf":
		if bytes.HasPrefix(prefix, []byte("%PDF-")) {
			return "application/pdf", nil
		}
	case ".docx":
		if bytes.HasPrefix(prefix, []byte{'P', 'K', 0x03, 0x04}) {
			return "application/vnd.openxmlformats-officedocument.wordprocessingml.document", nil
		}
	case ".txt", ".md":
		if validTextContent(prefix) {
			if extension == ".txt" {
				return "text/plain", nil
			}
			return "text/markdown", nil
		}
	case ".json":
		if validTextContent(prefix) && json.Valid(prefix) {
			return "application/json", nil
		}
	}
	return "", fmt.Errorf("unsupported file content")
}

func validTextContent(content []byte) bool {
	if bytes.IndexByte(content, 0) != -1 || bytes.HasPrefix(content, []byte{0x7f, 'E', 'L', 'F'}) || !utf8.Valid(content) {
		return false
	}
	for _, character := range content {
		if (character < 0x20 && character != '\n' && character != '\r' && character != '\t') || character == 0x7f {
			return false
		}
	}
	return true
}
func safeUploadExtension(name string) string {
	extension := strings.ToLower(filepath.Ext(name))
	if len(extension) > 10 || !regexp.MustCompile(`^\.[a-z0-9]+$`).MatchString(extension) {
		return ""
	}
	return extension
}

func uniqueTextList(field string, values []string, minimum, maximum, limit int) error {
	if len(values) < minimum || len(values) > maximum {
		return fmt.Errorf("%s must contain between %d and %d values", field, minimum, maximum)
	}
	seen := map[string]bool{}
	for index, value := range values {
		if err := requiredText(fmt.Sprintf("%s[%d]", field, index), value, limit); err != nil {
			return err
		}
		key := strings.ToLower(strings.TrimSpace(value))
		if seen[key] {
			return fmt.Errorf("%s contains duplicate value %q", field, value)
		}
		seen[key] = true
	}
	return nil
}
func allowedTextList(field string, values, allowed []string, minimum int) error {
	if len(values) < minimum || len(values) > len(allowed) {
		return fmt.Errorf("%s has an invalid number of values", field)
	}
	allowedSet, seen := map[string]bool{}, map[string]bool{}
	for _, value := range allowed {
		allowedSet[value] = true
	}
	for _, value := range values {
		if !allowedSet[value] || seen[value] {
			return fmt.Errorf("%s contains an unsupported or duplicate value", field)
		}
		seen[value] = true
	}
	return nil
}
func attachmentIDsValid(setupID, field string, ids []string, kind string) error {
	if len(ids) > 10 {
		return fmt.Errorf("%s contains too many attachments", field)
	}
	seen := map[string]bool{}
	for _, id := range ids {
		if !safeID.MatchString(id) {
			return fmt.Errorf("%s contains an invalid upload id", field)
		}
		if err := validateUploadedFile(setupID, id, kind, ""); err != nil {
			return fmt.Errorf("%s contains an unknown or mismatched upload id", field)
		}
		if seen[id] {
			return fmt.Errorf("%s contains duplicate upload id", field)
		}
		seen[id] = true
	}
	return nil
}

func newOpaqueID() (string, error) {
	buffer := make([]byte, 16)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return hex.EncodeToString(buffer), nil
}
func setupDirectory(id string) string       { return filepath.Join(setupStorageDirectory, id) }
func uploadDirectory(setupID string) string { return filepath.Join(setupDirectory(setupID), "uploads") }

func saveSetup(stored storedInterviewSetup) error {
	directory := setupDirectory(stored.ID)
	if err := ensurePrivateRuntimeDirectory(directory); err != nil {
		return err
	}
	path := filepath.Join(directory, "setup.json")
	lock, err := os.OpenFile(path+".lock", os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if os.IsExist(err) {
		return errSetupExists
	}
	if err != nil {
		return err
	}
	_ = lock.Close()
	defer os.Remove(path + ".lock")
	if _, err := os.Stat(path); err == nil {
		return errSetupExists
	} else if !os.IsNotExist(err) {
		return err
	}
	return writePrivateJSONAtomic(path, stored)
}
func loadSetup(id string) (storedInterviewSetup, error) {
	var stored storedInterviewSetup
	raw, err := os.ReadFile(filepath.Join(setupDirectory(id), "setup.json"))
	if err != nil {
		return stored, err
	}
	if err := json.Unmarshal(raw, &stored); err != nil {
		return stored, err
	}
	return stored, nil
}

func validateUploadedFile(setupID, id, kind, sourceType string) error {
	raw, err := os.ReadFile(filepath.Join(uploadDirectory(setupID), id+".json"))
	if err != nil {
		return err
	}
	var metadata uploadedInterviewFile
	if err := json.Unmarshal(raw, &metadata); err != nil {
		return err
	}
	if metadata.ID != id || metadata.SetupID != setupID || metadata.Kind != kind || (sourceType != "" && metadata.CandidateSourceType != sourceType) {
		return fmt.Errorf("upload metadata does not match")
	}
	return nil
}
func writePrivateJSON(path string, value any) error {
	raw, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, raw, 0o600)
}

func writePrivateJSONAtomic(path string, value any) error {
	if err := ensurePrivateRuntimeDirectory(filepath.Dir(path)); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".setup-*.tmp")
	if err != nil {
		return err
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return err
	}
	if _, err := temporary.Write(raw); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(temporaryName, path)
}
func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
