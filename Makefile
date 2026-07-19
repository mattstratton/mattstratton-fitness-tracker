PYTHON := /opt/homebrew/bin/python3

.PHONY: sync sync-hae sync-liftosaur db install-agent uninstall-agent

sync: sync-hae sync-liftosaur

sync-hae:
	$(PYTHON) ingest_hae.py

sync-liftosaur:
	$(PYTHON) sync_liftosaur.py

db:
	sqlite3 fitness.db

install-agent:
	mkdir -p logs
	cp com.mattstratton.fitness-sync.plist ~/Library/LaunchAgents/
	launchctl bootstrap gui/$$(id -u) ~/Library/LaunchAgents/com.mattstratton.fitness-sync.plist

uninstall-agent:
	launchctl bootout gui/$$(id -u)/com.mattstratton.fitness-sync || true
	rm -f ~/Library/LaunchAgents/com.mattstratton.fitness-sync.plist
