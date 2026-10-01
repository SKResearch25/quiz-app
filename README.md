# Quiz app – Netlify deploy
Players: https://YOURSITE.netlify.app   Admin: https://YOURSITE.netlify.app/#admin

## Deploy (CLI)
1. npm install
2. npx netlify-cli login
3. npx netlify-cli deploy --prod   (create a new site when asked; publish dir = public)
4. In Netlify: Site settings > Environment variables > add ADMIN_PASSWORD (your secret), then redeploy.
Alternative: push this folder to GitHub and "Import project" in Netlify.
(Without ADMIN_PASSWORD the default password is admin123 — change it!)
