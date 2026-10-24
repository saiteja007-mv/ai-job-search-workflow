---
name: linkedin-profile-search
description: This skill should be used when the user asks to "find LinkedIn profiles by company", "search LinkedIn employees at a location", "extract LinkedIn profiles from company", "get employee list from LinkedIn", or mentions searching for professionals by company name and location. Exports results to terminal, Excel, and PDF.
version: 0.1.0
---

# LinkedIn Profile Search

Search for LinkedIn profiles by company name and location without requiring login credentials. Extract basic profile information (name, title, location) and export results to terminal display, Excel spreadsheet, and formatted PDF report.

## Purpose

This skill enables searching for LinkedIn profiles based on company and location criteria using public data scraping techniques. Results are extracted, formatted, and exported to multiple formats for easy analysis and sharing.

## When to Use

Use this skill when the user requests:
- Finding employees at a specific company and location
- Building a list of LinkedIn profiles matching company/location criteria
- Exporting LinkedIn search results to Excel or PDF
- Researching professionals at target companies

## How It Works

The skill uses a Python-based scraper that:
1. Constructs LinkedIn search URLs with company and location filters
2. Scrapes public profile data without authentication
3. Extracts basic information (name, title, location)
4. Displays results in terminal with formatted table
5. Exports to Excel (.xlsx) with proper columns
6. Generates PDF report with company header and profile list

## Usage Workflow

### Step 1: Gather Search Parameters

Ask the user for:
- **Company name**: The target company (e.g., "Microsoft", "Google")
- **Location**: City, state, or country (e.g., "New York, NY", "San Francisco")

### Step 2: Execute the Search Script

Run the LinkedIn search script with the provided parameters:

```bash
python scripts/linkedin_search.py --company "Company Name" --location "Location" --output results
```

The script will:
- Search LinkedIn for matching profiles
- Extract basic profile data
- Display results in terminal
- Save to `results.xlsx` and `results.pdf`

### Step 3: Review and Present Results

- Display the terminal summary showing count and sample profiles
- Confirm Excel and PDF files were created
- Provide file paths to the user

## Script Reference

### Main Search Script

**`scripts/linkedin_search.py`** - Main LinkedIn profile search and export script

**Parameters:**
- `--company`: Company name to search (required)
- `--location`: Location filter (required)
- `--output`: Output filename prefix (default: "linkedin_results")
- `--limit`: Maximum number of profiles to extract (default: 50)

**Outputs:**
- Terminal display with formatted table
- Excel file: `{output}.xlsx`
- PDF file: `{output}.pdf`

### Supporting Utilities

**`scripts/requirements.txt`** - Python dependencies for the search script

Install dependencies before first use:
```bash
pip install -r scripts/requirements.txt
```

## Output Formats

### Terminal Display

Formatted table showing:
- Profile count
- Name, Title, Location columns
- Truncated for readability (max 20 rows displayed)

### Excel File (.xlsx)

Spreadsheet with columns:
- Name
- Title
- Current Company
- Location
- Profile URL

### PDF Report

Formatted document with:
- Search criteria header
- Results summary
- Profile table with all extracted data
- Timestamp and generation info

## Examples

See `examples/` directory for:
- **`example_search.sh`** - Sample search command
- **`example_output.xlsx`** - Sample Excel output
- **`example_output.pdf`** - Sample PDF output

## Limitations and Considerations

### No Authentication Required

This skill uses public scraping without login, which means:
- Only publicly visible profiles are accessible
- Results may be limited compared to authenticated searches
- Rate limiting may apply

### Ethical Usage

Follow LinkedIn's Terms of Service:
- Use for legitimate research purposes
- Respect privacy of individuals
- Avoid excessive scraping that impacts LinkedIn's servers
- Consider LinkedIn's official API for commercial use

### Rate Limits

To avoid being blocked:
- Add delays between requests (script includes random delays)
- Limit result count to reasonable numbers (50-100 max)
- Don't run multiple searches in rapid succession

## Troubleshooting

### Script Errors

If the script fails:
1. Check internet connection
2. Verify company name spelling
3. Try broader location (e.g., "United States" vs "New York, NY")
4. Reduce `--limit` parameter
5. Check if LinkedIn changed their HTML structure (may need script update)

### Empty Results

If no profiles found:
- Verify company exists on LinkedIn
- Try alternate company name spellings
- Broaden location criteria
- Check if company has public employee listings

### Export Issues

If Excel/PDF generation fails:
- Ensure dependencies installed: `pip install -r scripts/requirements.txt`
- Check write permissions in output directory
- Verify sufficient disk space

## Additional Resources

### Reference Files

For detailed technical information:
- **`references/linkedin_search_api.md`** - LinkedIn search URL structure and parameters
- **`references/scraping_best_practices.md`** - Ethical scraping guidelines and techniques

### Example Files

Working examples in `examples/`:
- **`example_search.sh`** - Complete search workflow
- **`example_output.xlsx`** - Sample Excel output format
- **`example_output.pdf`** - Sample PDF report format

## Implementation Notes

### Dependencies

The skill requires:
- Python 3.8+
- requests library (HTTP requests)
- beautifulsoup4 (HTML parsing)
- pandas (data manipulation)
- openpyxl (Excel export)
- reportlab (PDF generation)

Install with: `pip install -r scripts/requirements.txt`

### Customization

To modify extracted fields:
1. Edit `scripts/linkedin_search.py`
2. Update `extract_profile_data()` function
3. Add new columns to Excel/PDF exports

To change output formatting:
1. Modify `generate_excel()` for spreadsheet styling
2. Update `generate_pdf()` for report layout

## Quick Start

Complete workflow for first-time use:

```bash
# 1. Install dependencies
cd ~/.claude/skills/linkedin-profile-search
pip install -r scripts/requirements.txt

# 2. Run search
python scripts/linkedin_search.py --company "Google" --location "California" --output google_ca

# 3. Check outputs
ls -lh google_ca.xlsx google_ca.pdf
```

Results will be displayed in terminal and saved to files.
