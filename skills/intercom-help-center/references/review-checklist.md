# Review checklist

Run the `help-center-reviewer` agent on every drafted or changed article first. Then go through this list with the user. For each item, say PASS, FAIL (and fix it) or NOT CHECKED (and why). An honest NOT CHECKED is worth more than a PASS nobody verified.

- [ ] Every claim traces to a file in `sources:`; nothing described has not shipped
- [ ] Every button and setting label matches the UI strings exactly, in bold
- [ ] Every number (default, limit, price, time) is in the code or strings
- [ ] Title is a question a customer would search, and matches the body's scope
- [ ] One topic; the first two sentences say what the reader can do
- [ ] "What this does NOT do" is specific, not boilerplate
- [ ] Money, deletion or anything irreversible: the article says who confirms it and where
- [ ] No jargon, internal names, vendor names or roadmap promises
- [ ] The pre-write check was run: this updates the right article, or no article covered it
- [ ] Updating: only wrong claims changed; embeds and raw HTML untouched; same id
- [ ] Links point at real articles (or will once their targets publish)
- [ ] Someone opened the real screen, or the steps are marked unverified in a reviewer comment
- [ ] `node S/publish.mjs <file>` (dry run) shows the expected changes and nothing else
- [ ] `state` is set to `published` by a human, not by you
