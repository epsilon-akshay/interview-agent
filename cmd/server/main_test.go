package main

import (
	"encoding/base64"
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
