# LinkedIn Profile Search Skill

Search for LinkedIn profiles by company and location without requiring login credentials. Extract basic profile information and export to terminal, Excel, and PDF.

## Installation

### 1. Install Python Dependencies

```bash
cd ~/.claude/skills/linkedin-profile-search/scripts
pip install -r requirements.txt
```

### 2. Verify Installation

```bash
python linkedin_search.py --help
```

## Usage

### Basic Search

```bash
python scripts/linkedin_search.py \
  --company "Microsoft" \
  --location "Seattle, WA" \
  --output microsoft_seattle
```

### With Limit

```bash
python scripts/linkedin_search.py \
  --company "Google" \
  --location "California" \
  --output google_ca \
  --limit 30
```

## Using in Claude Code

Simply ask Claude:
- "Find LinkedIn profiles for Apple employees in California"
- "Search LinkedIn for Microsoft employees in New York"
- "Get employee list from Google in Mountain View"

Claude will automatically use this skill to:
1. Run the search
2. Display results in terminal
3. Export to Excel and PDF

## Output Files

After running a search, you'll get:
- **Excel file** (`.xlsx`): Structured data with columns for Name, Title, Company, Location, Profile URL
- **PDF report** (`.pdf`): Formatted report with search criteria and results table
- **Terminal display**: Summary table with key information

## Parameters

| Parameter | Required | Description | Default |
|-----------|----------|-------------|---------|
| `--company` | Yes | Company name to search | - |
| `--location` | Yes | Location filter | - |
| `--output` | No | Output filename prefix | `linkedin_results` |
| `--limit` | No | Maximum profiles to extract | 50 |

## Examples

See `examples/example_search.sh` for a complete working example.

## Limitations

- No authentication required (uses public data only)
- Limited to publicly visible profiles
- Rate limiting applies (50-100 profiles per day recommended)
- Results depend on Google search indexing

## Ethical Usage

This tool is for:
- Educational purposes
- Personal research
- Small-scale data collection

For commercial use, consider LinkedIn's official API or licensed data partners.

See `references/scraping_best_practices.md` for detailed ethical guidelines.

## Troubleshooting

### "No results found"
- Verify company name spelling
- Try broader location (e.g., "United States" vs "New York, NY")
- Reduce `--limit` parameter

### "Module not found" error
- Run: `pip install -r scripts/requirements.txt`
- Ensure Python 3.8+ is installed

### "Permission denied" error
- Make script executable: `chmod +x scripts/linkedin_search.py`
- Or run with: `python scripts/linkedin_search.py ...`

## File Structure

```
linkedin-profile-search/
├── SKILL.md                              # Main skill documentation
├── README.md                             # This file
├── scripts/
│   ├── linkedin_search.py               # Main search script
│   └── requirements.txt                 # Python dependencies
├── references/
│   └── scraping_best_practices.md       # Ethical scraping guidelines
└── examples/
    └── example_search.sh                # Example usage
```

## Version

Current version: 0.1.0

## License

For personal and educational use only. Respect LinkedIn's Terms of Service.
