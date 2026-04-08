UUID = keep-awake@keep-awake-gnome
EXTENSION_DIR = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

.PHONY: install uninstall zip clean

install:
	mkdir -p $(EXTENSION_DIR)
	cp -r extension.js metadata.json icons $(EXTENSION_DIR)/
	@echo "Installed. Log out and back in, then run:"
	@echo "  gnome-extensions enable $(UUID)"

uninstall:
	rm -rf $(EXTENSION_DIR)
	rm -f $(HOME)/.config/keep-awake-state.json
	@echo "Uninstalled. Log out and back in to complete removal."

zip:
	zip -r keep-awake-gnome.zip extension.js metadata.json icons/

clean:
	rm -f keep-awake-gnome.zip
