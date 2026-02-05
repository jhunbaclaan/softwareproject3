# Nexus Agent

Repository for csci-4911 project 3; created by Jhun Baclaan, Kealohi Young, Joshua Leonard, and Adriane Fiesta

## Environment

- **Conda** manages system-level dependencies (Python 3.11, Node.js 20)
- **uv** manages Python packages for fast installation
- **npm** manages JavaScript packages for frontend and MCP server


## Setup

```bash
# 1. Create and activate conda environment (installs Python, Node.js, uv)
conda env create -f environment.yml
conda activate NexusAgent

# 2. Install Python packages with uv
cd backend && uv pip install -r requirements.txt

# 3. Install frontend dependencies
cd ../frontend && npm install

# 4. Install MCP server dependencies
cd ../mcp-server && npm install
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

## Updating Dependencies

```bash
# Update Python packages (use uv)
cd backend && uv pip install <package-name>
cd backend && uv pip install -r requirements.txt --upgrade

# Update Node packages (use npm as usual)
cd frontend && npm install <package-name>
cd mcp-server && npm install <package-name>
```
