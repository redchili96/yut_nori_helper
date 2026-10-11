# Static deployment

Yut Nori Helper is a static, browser-local application. It does not require a database, backend, login or external API.

## Publish

Upload the contents of this folder to the root of any static web host. The following relative paths must remain intact:

- `index.html`
- `styles.css`
- `assets/`
- `src/`

For local testing:

```bash
python -m http.server 8080
```

Then open `http://localhost:8080`.

## Data behavior

Game history is stored in the browser. Users explicitly export JSON when they want to share community logs. Clearing browser storage can remove locally stored history, so users who care about their dataset should export it periodically.
