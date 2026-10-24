#!/bin/bash
# Example: Search for Google employees in California

# Navigate to script directory
cd ~/.claude/skills/linkedin-profile-search/scripts

# Run search
python linkedin_search.py \
  --company "Google" \
  --location "California" \
  --output google_california_results \
  --limit 30

# Results will be saved to:
# - google_california_results.xlsx
# - google_california_results.pdf
