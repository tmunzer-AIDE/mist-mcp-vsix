SHELL := /bin/sh
DIST_DIR := dist

.PHONY: help ensure-version set-version deps compile test package clean

help:
	@echo "Usage: make package VERSION=x.y.z"
	@echo ""
	@echo "Targets:"
	@echo "  make package VERSION=x.y.z  Bump version, compile, test, and build VSIX"
	@echo "  make clean                  Remove build artifacts"

ensure-version:
	@if [ -z "$(VERSION)" ]; then \
		echo "Error: VERSION is required."; \
		echo "Example: make package VERSION=0.1.0"; \
		exit 1; \
	fi

set-version: ensure-version
	npm version "$(VERSION)" --no-git-tag-version

deps:
	npm install

compile:
	npm run compile

test:
	npm test

package: set-version deps compile test
	npm run package
	mkdir -p $(DIST_DIR)
	mv -f *.vsix $(DIST_DIR)/

clean:
	rm -rf out
	rm -rf $(DIST_DIR)