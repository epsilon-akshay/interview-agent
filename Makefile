.PHONY: install dev build run check

GO_CACHE := $(CURDIR)/.cache/go-build

install:
	cd web && npm install

dev:
	@echo "Run these in separate terminals:"
	@echo "  go run ./cmd/server -dev-dir web"
	@echo "  cd web && npm run dev"

build:
	cd web && npm run build
	GOCACHE=$(GO_CACHE) go build -o bin/interviewer ./cmd/server

run: build
	./bin/interviewer

check:
	cd web && npm run typecheck
	GOCACHE=$(GO_CACHE) go test ./...
