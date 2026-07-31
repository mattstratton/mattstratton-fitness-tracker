PYTHON := /opt/homebrew/bin/python3

.PHONY: sync sync-hae sync-liftosaur check test db install-agent uninstall-agent

# The leading '-' lets an unreadable HAE export still not block the Liftosaur
# pull. The failure isn't swallowed — `check` re-raises it via the exit code.
sync:
	-$(PYTHON) ingest_hae.py
	$(PYTHON) sync_liftosaur.py
	@$(MAKE) --no-print-directory check

sync-hae:
	$(PYTHON) ingest_hae.py

sync-liftosaur:
	$(PYTHON) sync_liftosaur.py

check:
	$(PYTHON) check_freshness.py

test:
	$(PYTHON) -m unittest discover -p 'test_*.py'

db:
	sqlite3 fitness.db

install-agent:
	mkdir -p logs
	cp com.mattstratton.fitness-sync.plist ~/Library/LaunchAgents/
	launchctl bootstrap gui/$$(id -u) ~/Library/LaunchAgents/com.mattstratton.fitness-sync.plist

uninstall-agent:
	launchctl bootout gui/$$(id -u)/com.mattstratton.fitness-sync || true
	rm -f ~/Library/LaunchAgents/com.mattstratton.fitness-sync.plist
