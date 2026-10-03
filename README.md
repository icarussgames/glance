# Glance

A personal at-a-glance page for lists of notes. Each note has a title, an optional start date, and steps you can tick off. The open list shows overall progress, and each note shows its own count and bar.

There is no account and no server. What you type stays in this browser (`localStorage`). The first visit is empty until you create a list.

## Run locally

From the project folder, serve the `public` directory:

```bash
python3 -m http.server 47321 -d public
```

Open [http://127.0.0.1:47321](http://127.0.0.1:47321).

Any static file server works. `index.html` should be at the site root.

## Deploy on Render

Glance is a static site. No build step and no backend.

[`render.yaml`](render.yaml) is a Render Blueprint for one static site. The build command is `true` (a no-op), and the publish directory is `public`.

1. Push this project to a Git repository Render can access.
2. In the Render dashboard, choose **New → Blueprint** and select that repository.
3. Apply the blueprint. Render publishes the `public` folder.

To create the site by hand instead: **New → Static Site**, set the build command to `true`, and set the publish directory to `public`.

Lists still live in each visitor's browser, not on Render.

## GitHub Pages

The site is published from the `public` folder by `.github/workflows/pages.yml`.

https://icarussgames.github.io/glance/
