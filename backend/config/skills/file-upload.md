# File Upload Skill

Use when the application lets users upload files.

Cover:

- Each accepted file type uploads and is shown as attached (name, and size or
  preview where the app shows one).
- A file type that is not accepted is rejected with a clear message, including
  a renamed file (an .exe renamed to .pdf) where the app checks content.
- An empty (0-byte) file and a corrupt file of an accepted type.
- A file just under and just over the size limit, when a limit is stated or shown.
- The maximum number of files, and one more, when multiple files are allowed.
- Removing or replacing an attached file before submitting.
- Submitting without the file when it is required, and when it is optional.
- When an upload is required only in some situations, both sides of that
  condition.
- A file name with spaces, special characters and a long name.

Use only file types, limits and counts that are observed or stated. Name test
files concretely (for example "id-card.pdf", "photo.png", "empty.pdf").
