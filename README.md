# Football Analytics Hub

A live, AI-powered football analytics platform built as a portfolio project for a Football Infrastructure Analyst application at Shortlistr.

**Live demo:** https://football-analytics-hub.vercel.app

---

## What It Does

**Player Scouting** — search and filter 2,135 players from StatsBomb's La Liga open dataset. View per-90 metrics, position-normalized radar charts, and percentile rankings against positional peers. Compare two players side-by-side with an overlaid radar and dual percentile columns.

**Match Analysis** — select any of 868 La Liga matches and view KPI summaries (shots, xG, possession, pass completion, PPDA, progressive passes), an interactive shot map plotted on a pitch SVG, and a pass network showing average player positions and passing connections.

**AI Assistant** — a Claude-powered panel accessible from any page that generates scouting reports, post-match coaching briefs, player comparison reports, and answers natural language questions grounded in the data on screen.

---

## Architecture

StatsBomb open data (868 matches, La Liga) feeds into a Python pipeline (scripts/load_data.py) that computes per-90 metrics for 2,135 players and exports clean JSON. Those files are served via Next.js API routes (/api/players, /api/matches, /api/match-events) to a React frontend, with the Anthropic Claude API powering the AI assistant layer on top.

This mirrors the pattern for production APIs like Wyscout, Impect, or SkillCorner — swap the StatsBomb calls for their endpoints and the rest of the pipeline is identical.

---

## AI Skills Architecture

The AI assistant uses a reusable skills system in lib/skills/ — separate prompt modules that define Claude's behaviour per use case:

- **scoutingReportSkill.ts** — acts as a senior scout writing for a Sporting Director. Outputs: Overview, Key Strengths, Areas of Concern, Positional Fit, Transfer Recommendation.
- **coachingBriefSkill.ts** — acts as a first-team analyst writing for the head coach. Outputs: What Worked, What Didn't, Key Performances, Tactical Recommendation.
- **comparisonReportSkill.ts** — side-by-side comparison of two transfer targets with a decisive recommendation.
- **naturalLanguageSkill.ts** — answers questions grounded strictly in the data currently loaded in the app.

Each skill is a reusable prompt module — the same pattern used in production agentic systems.

---

## Built With Claude Code

This entire project was built using Claude Code as the primary development environment — directing the AI to scaffold, build, debug, and extend each module iteratively rather than writing code manually. That workflow is how modern AI-era infrastructure gets built.

---

## Running Locally

Prerequisites: Node.js 18+, Python 3.9+

Clone the repo and install dependencies:

    git clone https://github.com/jonlawrence017/football-analytics-hub.git
    cd football-analytics-hub
    npm install

Generate the data (takes 15-30 minutes on first run):

    python scripts/load_data.py

Add your Anthropic API key — create a file called .env.local in the project root:

    ANTHROPIC_API_KEY=your_key_here

Start the dev server:

    npm run dev

Visit http://localhost:3000

---

## Tech Stack

- **Frontend:** Next.js 14 (App Router), TypeScript, Tailwind CSS, Recharts
- **Data:** StatsBomb open data via statsbombpy
- **AI:** Anthropic Claude API (claude-sonnet-4-6), streaming responses
- **Deployment:** Vercel