# Capsule Workflow Design

White operating interface for personal private exchanges. Four persistent
destinations: My Capsules, Send, Collect, Open. Send owns Prompt/Files tabs.
Collect owns one-reply requests and multiple-response forms. Recipient routes
retain their keys and present focused content, not a creation workspace.

Desktop uses a 216px left navigation rail; tablet uses a compact top navigation;
mobile uses four bottom destinations. Editors use compact 30px headings, unframed
section bands, and a consistent sharing receipt. Inputs/buttons use 6px radii,
framed tools use 8px. White background, neutral gray borders, blue actions, green
ready states, and red errors. No hero-size typography inside the application.

Canonical routes: /workspace, /send/prompt, /send/files, /collect,
/collect/request, /collect/form, /open. Legacy query tabs and /c, /r, /f public
links remain supported. User navigation pushes history; boot preserves recipient
URLs. One delegated navigation handler also covers dynamically rendered controls.
