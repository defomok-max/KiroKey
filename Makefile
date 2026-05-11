# Convenience targets for kiro-router.
# Each target is independent — install, build, run, test as needed.

.PHONY: install build start dev test typecheck check clean

install:
	npm install

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

check: typecheck test

clean:
	rm -rf node_modules dist
