.PHONY: install dev build run check browser-test check-web-freshness scan-web-assets release-check doctor doctor-test clean-build purge-runtime

GO_CACHE := $(CURDIR)/.cache/go-build

install:
	cd web && npm ci

dev:
	@echo "Run these in separate terminals:"
	@echo "  go run ./cmd/server -dev-dir web"
	@echo "  cd web && npm run dev"

build:
	cd web && npm run build
	mkdir -p bin
	GOCACHE=$(GO_CACHE) go build -o bin/interviewer ./cmd/server

run: build
	./bin/interviewer

check:
	cd web && npm run test:unit
	cd web && npm run typecheck
	GOCACHE=$(GO_CACHE) go test ./...

browser-test:
	cd web && npm run test:browser

check-web-freshness:
	./scripts/check-embedded-web.sh

scan-web-assets:
	./scripts/check-frontend-assets.sh cmd/server/webdist

release-check:
	$(MAKE) check
	$(MAKE) doctor-test
	$(MAKE) check-web-freshness
	$(MAKE) scan-web-assets
	$(MAKE) browser-test
	GOCACHE=$(GO_CACHE) go test -race ./...
	GOCACHE=$(GO_CACHE) go vet ./...
	$(MAKE) build
	$(MAKE) check-web-freshness
	$(MAKE) scan-web-assets

doctor:
	./scripts/doctor.sh

doctor-test:
	./scripts/test-doctor.sh

clean-build:
	./scripts/clean-build.sh

purge-runtime:
	@echo "DESTRUCTIVE: this permanently deletes private interview data under $(CURDIR)/runtime."
	@test "$(CONFIRM_PURGE_RUNTIME)" = "DELETE_RUNTIME" || (echo "Refusing. Re-run with CONFIRM_PURGE_RUNTIME=DELETE_RUNTIME." && exit 1)
	./scripts/purge-runtime.sh
