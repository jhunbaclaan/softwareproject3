# Nexus Agent

Repository for csci-4911 project 3; created by jhun baclaan, kealohi young, joshua leonard, and adriane fiesta

## Setup

```bash
conda env create -f environment.yml
conda activate NexusAgent
cd backend && pip install -r requirements.txt
cd frontend && npm install
cd mcp-server && npm install
```

## Run

```bash
# Terminal 1 - Backend
cd backend && uvicorn main:app --reload

# Terminal 2 - MCP Server (future)
cd mcp-server && npm start

# Terminal 3 - Frontend
cd frontend && npm run dev
```
