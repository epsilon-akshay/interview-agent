package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestDecodeWhiteboardPNG(t *testing.T) {
	pngHeader := []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}
	dataURL := "data:image/png;base64," + base64.StdEncoding.EncodeToString(pngHeader)

	decoded, err := decodeWhiteboardPNG(dataURL)
	if err != nil {
		t.Fatalf("decodeWhiteboardPNG returned an error: %v", err)
	}
	if string(decoded) != string(pngHeader) {
		t.Fatalf("decoded PNG differs from input")
	}

	if _, err := decodeWhiteboardPNG("data:image/jpeg;base64,AAAA"); err == nil {
		t.Fatalf("expected a non-PNG data URL to fail")
	}
}

func TestSafeArtifactName(t *testing.T) {
	if name, err := safeArtifactName("session_123-abc"); err != nil || name != "session_123-abc" {
		t.Fatalf("expected a valid session name, got %q and %v", name, err)
	}
	if _, err := safeArtifactName("../../private"); err == nil {
		t.Fatalf("expected path traversal characters to fail")
	}
}

func TestSaveWhiteboardArtifacts(t *testing.T) {
	workingDirectory, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	temporaryDirectory := t.TempDir()
	if err := os.Chdir(temporaryDirectory); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(workingDirectory) })

	input := evaluationRequest{
		SessionID:          "session-123",
		WhiteboardRevision: 4,
		WhiteboardSummary:  `{"elementCount":2}`,
		WhiteboardScene:    `{"tldrawFileFormatVersion":1,"schema":{},"records":[]}`,
	}
	pngHeader := []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}
	if err := saveWhiteboardArtifacts(input, pngHeader); err != nil {
		t.Fatalf("saveWhiteboardArtifacts returned an error: %v", err)
	}

	for _, name := range []string{"session-123.summary.json", "session-123.tldr", "session-123.png"} {
		if _, err := os.Stat(filepath.Join("runtime", "whiteboards", name)); err != nil {
			t.Fatalf("expected %s to be saved: %v", name, err)
		}
	}
}

func TestInterviewSetupCreateAndRead(t *testing.T) {
	withTemporaryWorkingDirectory(t)
	requestBody, err := json.Marshal(validInterviewSetup())
	if err != nil {
		t.Fatal(err)
	}
	create := httptest.NewRequest(http.MethodPost, "/api/interview/setups", bytes.NewReader(requestBody))
	create.Header.Set("Content-Type", "application/json")
	created := httptest.NewRecorder()
	interviewSetupsHandler(created, create)
	if created.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", created.Code, created.Body.String())
	}
	var stored storedInterviewSetup
	if err := json.NewDecoder(created.Body).Decode(&stored); err != nil {
		t.Fatal(err)
	}
	if !safeID.MatchString(stored.ID) || stored.Setup.Role.Title != "Backend Engineer" {
		t.Fatalf("unexpected stored setup: %#v", stored)
	}
	read := httptest.NewRecorder()
	interviewSetupHandler(read, httptest.NewRequest(http.MethodGet, "/api/interview/setups/"+stored.ID, nil))
	if read.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", read.Code, read.Body.String())
	}
	if _, err := os.Stat(filepath.Join(setupDirectory(stored.ID), "setup.json")); err != nil {
		t.Fatalf("expected setup snapshot to exist: %v", err)
	}
}

func TestInterviewSetupRejectsDuplicateSnapshot(t *testing.T) {
	withTemporaryWorkingDirectory(t)
	body, err := json.Marshal(validInterviewSetup())
	if err != nil {
		t.Fatal(err)
	}
	for attempt := 1; attempt <= 2; attempt++ {
		recorder := httptest.NewRecorder()
		interviewSetupsHandler(recorder, httptest.NewRequest(http.MethodPost, "/api/interview/setups", bytes.NewReader(body)))
		expected := http.StatusCreated
		if attempt == 2 {
			expected = http.StatusConflict
		}
		if recorder.Code != expected {
			t.Fatalf("attempt %d: expected %d, got %d: %s", attempt, expected, recorder.Code, recorder.Body.String())
		}
	}
}

func TestInterviewSetupRejectsInvalidRubricWeight(t *testing.T) {
	setup := validInterviewSetup()
	setup.Rubric.Criteria[1].Weight = 30
	body, err := json.Marshal(setup)
	if err != nil {
		t.Fatal(err)
	}
	recorder := httptest.NewRecorder()
	interviewSetupsHandler(recorder, httptest.NewRequest(http.MethodPost, "/api/interview/setups", bytes.NewReader(body)))
	if recorder.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422, got %d: %s", recorder.Code, recorder.Body.String())
	}
}

func TestInterviewSetupRejectsUnknownJSONFieldAndHTTPSource(t *testing.T) {
	withTemporaryWorkingDirectory(t)
	setup := validInterviewSetup()
	body, err := json.Marshal(setup)
	if err != nil {
		t.Fatal(err)
	}
	unknown := append(body[:len(body)-1], []byte(`,"unexpected":true}`)...)
	recorder := httptest.NewRecorder()
	interviewSetupsHandler(recorder, httptest.NewRequest(http.MethodPost, "/api/interview/setups", bytes.NewReader(unknown)))
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for unknown field, got %d", recorder.Code)
	}
	setup.Candidate.Sources = []candidateSource{{Type: "github", Reference: "http://example.com/alex"}}
	body, err = json.Marshal(setup)
	if err != nil {
		t.Fatal(err)
	}
	recorder = httptest.NewRecorder()
	interviewSetupsHandler(recorder, httptest.NewRequest(http.MethodPost, "/api/interview/setups", bytes.NewReader(body)))
	if recorder.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422 for HTTP source, got %d: %s", recorder.Code, recorder.Body.String())
	}
	setup = validInterviewSetup()
	setup.Candidate.Sources = []candidateSource{{Type: "resume", Reference: "https://example.com/resume"}}
	body, err = json.Marshal(setup)
	if err != nil {
		t.Fatal(err)
	}
	recorder = httptest.NewRecorder()
	interviewSetupsHandler(recorder, httptest.NewRequest(http.MethodPost, "/api/interview/setups", bytes.NewReader(body)))
	if recorder.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422 for a resume URL, got %d: %s", recorder.Code, recorder.Body.String())
	}
	setup = validInterviewSetup()
	setup.Candidate.Sources = []candidateSource{{Type: "github", Reference: "https://github.com/example"}}
	body, err = json.Marshal(setup)
	if err != nil {
		t.Fatal(err)
	}
	recorder = httptest.NewRecorder()
	interviewSetupsHandler(recorder, httptest.NewRequest(http.MethodPost, "/api/interview/setups", bytes.NewReader(body)))
	if recorder.Code != http.StatusCreated {
		t.Fatalf("expected 201 for a GitHub HTTPS source, got %d: %s", recorder.Code, recorder.Body.String())
	}
	valid, err := json.Marshal(validInterviewSetup())
	if err != nil {
		t.Fatal(err)
	}
	recorder = httptest.NewRecorder()
	secondValue := append(valid, []byte(` {}`)...)
	interviewSetupsHandler(recorder, httptest.NewRequest(http.MethodPost, "/api/interview/setups", bytes.NewReader(secondValue)))
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for a second JSON value, got %d", recorder.Code)
	}
}

func TestInterviewSetupRejectsMissingAndCrossSetupUploads(t *testing.T) {
	withTemporaryWorkingDirectory(t)
	setup := validInterviewSetup()
	setup.Brief.AttachmentIDs = []string{"fedcba9876543210fedcba9876543210"}
	body, err := json.Marshal(setup)
	if err != nil {
		t.Fatal(err)
	}
	recorder := httptest.NewRecorder()
	interviewSetupsHandler(recorder, httptest.NewRequest(http.MethodPost, "/api/interview/setups", bytes.NewReader(body)))
	if recorder.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422 for missing attachment, got %d", recorder.Code)
	}
	otherSetupID := "abcdef0123456789abcdef0123456789"
	upload := createCandidateUpload(t, otherSetupID)
	setup.Candidate.Sources = []candidateSource{{Type: "resume", Reference: "upload:" + upload.ID}}
	setup.Brief.AttachmentIDs = nil
	body, err = json.Marshal(setup)
	if err != nil {
		t.Fatal(err)
	}
	recorder = httptest.NewRecorder()
	interviewSetupsHandler(recorder, httptest.NewRequest(http.MethodPost, "/api/interview/setups", bytes.NewReader(body)))
	if recorder.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422 for cross-setup upload, got %d: %s", recorder.Code, recorder.Body.String())
	}
}

func TestInterviewUploadRequiresSetupID(t *testing.T) {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	if err := writer.WriteField("kind", "brief"); err != nil {
		t.Fatal(err)
	}
	part, err := writer.CreateFormFile("file", "brief.txt")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write([]byte("brief")); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/interview/uploads", &body)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	recorder := httptest.NewRecorder()
	interviewUploadHandler(recorder, request)
	if recorder.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422 without setupId, got %d", recorder.Code)
	}
}

func TestInterviewUploadStoresPrivateMetadata(t *testing.T) {
	withTemporaryWorkingDirectory(t)
	upload := createUpload(t, testSetupID, "candidate", "resume", "candidate.txt", []byte("candidate profile"))
	if upload.Kind != "candidate" || upload.CandidateSourceType != "resume" || upload.SizeBytes != int64(len("candidate profile")) {
		t.Fatalf("unexpected upload: %#v", upload)
	}
	if upload.SetupID != testSetupID {
		t.Fatalf("expected setup id %q, got %#v", testSetupID, upload)
	}
	if _, err := os.Stat(filepath.Join(uploadDirectory(testSetupID), upload.ID+".txt")); err != nil {
		t.Fatalf("expected uploaded file: %v", err)
	}
	if _, err := os.Stat(filepath.Join(uploadDirectory(testSetupID), upload.ID+".json")); err != nil {
		t.Fatalf("expected uploaded metadata: %v", err)
	}
}

func TestInterviewUploadRejectsNonResumeCandidateAndRenamedExecutable(t *testing.T) {
	withTemporaryWorkingDirectory(t)
	assertUploadStatus(t, testSetupID, "candidate", "linkedin", "profile.txt", []byte("profile"), http.StatusUnprocessableEntity)
	assertUploadStatus(t, testSetupID, "brief", "", "brief.txt", []byte{0x7f, 'E', 'L', 'F'}, http.StatusUnprocessableEntity)
	assertUploadStatus(t, testSetupID, "brief", "", "brief.pdf", []byte("%PDF-1.7\nbody"), http.StatusCreated)
	upload := createUpload(t, testSetupID, "brief", "", "brief.docx", []byte{'P', 'K', 0x03, 0x04, 'x'})
	if upload.ContentType != "application/vnd.openxmlformats-officedocument.wordprocessingml.document" {
		t.Fatalf("expected canonical DOCX type, got %q", upload.ContentType)
	}
}

const testSetupID = "0123456789abcdef0123456789abcdef"

func validInterviewSetup() interviewSetup {
	return interviewSetup{
		SetupID:                testSetupID,
		Version:                setupVersion,
		CandidateContextPolicy: candidateContextPolicy,
		Candidate:              setupCandidate{Name: "Alex Morgan", ReviewedFacts: []string{"Built Go services"}},
		Role:                   setupRole{Title: "Backend Engineer", Level: "Senior"},
		Interview:              setupInterview{Type: "coding", DurationSeconds: 1800, CodingLanguage: "go", QuestionTypes: []string{"coding", "debugging"}, Workspaces: []string{"code_editor", "whiteboard"}, Channels: []string{"voice"}},
		Brief:                  setupBrief{Text: "Assess API design and testing."},
		Rubric:                 setupRubric{Criteria: []rubricCriterion{{ID: "design", Name: "API design", Weight: 60, ExpectedEvidence: "Explains contracts and trade-offs."}, {ID: "testing", Name: "Testing", Weight: 40, ExpectedEvidence: "Writes or explains focused tests."}}},
	}
}

func withTemporaryWorkingDirectory(t *testing.T) {
	t.Helper()
	workingDirectory, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	temporaryDirectory := t.TempDir()
	if err := os.Chdir(temporaryDirectory); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(workingDirectory) })
}

func createCandidateUpload(t *testing.T, setupID string) uploadedInterviewFile {
	t.Helper()
	return createUpload(t, setupID, "candidate", "resume", "candidate.txt", []byte("candidate profile"))
}

func createUpload(t *testing.T, setupID, kind, sourceType, filename string, content []byte) uploadedInterviewFile {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	if err := writer.WriteField("kind", kind); err != nil {
		t.Fatal(err)
	}
	if err := writer.WriteField("setupId", setupID); err != nil {
		t.Fatal(err)
	}
	if sourceType != "" {
		if err := writer.WriteField("candidateSourceType", sourceType); err != nil {
			t.Fatal(err)
		}
	}
	part, err := writer.CreateFormFile("file", filename)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(content); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/interview/uploads", &body)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	recorder := httptest.NewRecorder()
	interviewUploadHandler(recorder, request)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("expected 201 upload, got %d: %s", recorder.Code, recorder.Body.String())
	}
	var upload uploadedInterviewFile
	if err := json.NewDecoder(recorder.Body).Decode(&upload); err != nil {
		t.Fatal(err)
	}
	return upload
}

func assertUploadStatus(t *testing.T, setupID, kind, sourceType, filename string, content []byte, expected int) {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	if err := writer.WriteField("kind", kind); err != nil {
		t.Fatal(err)
	}
	if err := writer.WriteField("setupId", setupID); err != nil {
		t.Fatal(err)
	}
	if sourceType != "" {
		if err := writer.WriteField("candidateSourceType", sourceType); err != nil {
			t.Fatal(err)
		}
	}
	part, err := writer.CreateFormFile("file", filename)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(content); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/interview/uploads", &body)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	recorder := httptest.NewRecorder()
	interviewUploadHandler(recorder, request)
	if recorder.Code != expected {
		t.Fatalf("expected %d upload status, got %d: %s", expected, recorder.Code, recorder.Body.String())
	}
}
