# Convenience targets for kiro-router.
# Each target is independent — install, build, run, test as needed.

.PHONY: install ci build start dev test typecheck lint pack-check check clean

install:
	npm install

ci:
	npm ci

build:
	npm run build

start:
	npm start

dev:
	npm run dev

test:
	npm test

typecheck:
	npm run typecheck

lint:
	npm run lint

pack-check:
	npm pack --dry-run

check:
	npm run check

clean:
	rm -rf node_modules dist
