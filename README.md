# BrandGuide Bot

AI brand strategy intake chatbot for Pretty Sweet Creative Studio.

## Deployment to Netlify

### Step 1 — Push to GitHub
1. Create a new repository on github.com called `brandguide-bot`
2. Upload all files in this folder to that repository

### Step 2 — Connect to Netlify
1. Go to app.netlify.com
2. Click "Add new site" → "Import an existing project"
3. Choose GitHub → select `brandguide-bot` repository
4. Build settings: leave all blank (no build command needed)
5. Click "Deploy site"

### Step 3 — Add Anthropic API Key
1. In Netlify dashboard → Site configuration → Environment variables
2. Add variable:
   - Key: `ANTHROPIC_API_KEY`
   - Value: your Anthropic API key (sk-ant-...)
3. Save and redeploy

### Step 4 — Set custom domain (optional)
In Netlify → Domain management → Add custom domain

## How it works
- User fills out brand questionnaire via voice or text chat
- Claude (via Netlify serverless function) guides the conversation
- On completion, answers submit directly to Google Form
- Google Form writes to Google Sheet
- n8n workflow triggers and generates PDF strategy report

## Files
- `public/index.html` — the chatbot frontend
- `netlify/functions/claude.js` — API proxy (handles CORS)
- `netlify.toml` — Netlify configuration
