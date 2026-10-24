#!/usr/bin/env python3
"""
LinkedIn People Finder - Core Module
Search for people by company and location on LinkedIn
"""

import requests
import json
import csv
import re
import argparse
from datetime import datetime
from typing import List, Dict, Optional
from pathlib import Path


class PeopleFinder:
    """Main class for LinkedIn people search"""

    def __init__(self):
        self.headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }

    def search(
        self,
        company: str,
        location: str,
        keywords: str = "",
        limit: int = 50,
        method: str = "duckduckgo"
    ) -> List[Dict]:
        """
        Search for LinkedIn profiles by company and location

        Args:
            company: Company name to search for
            location: Location (city, state, or country)
            keywords: Additional search terms (job titles, skills)
            limit: Maximum number of results
            method: Search method ('duckduckgo' or 'google')

        Returns:
            List of profile dictionaries
        """
        query = self._build_query(company, location, keywords)

        if method == "duckduckgo":
            results = self._search_duckduckgo(query, limit)
        else:
            results = self._search_google(query, limit)

        # Deduplicate
        return self._deduplicate(results)

    def _build_query(self, company: str, location: str, keywords: str = "") -> str:
        """Build LinkedIn search query"""
        query = f'site:linkedin.com/in/ "{company}" "{location}"'
        if keywords:
            query += f' {keywords}'
        return query

    def _search_duckduckgo(self, query: str, limit: int) -> List[Dict]:
        """Search using DuckDuckGo (no rate limits)"""
        try:
            # Try new package name first
            try:
                from ddgs import DDGS
            except ImportError:
                from duckduckgo_search import DDGS

            results = []
            ddgs = DDGS()
            search_results = ddgs.text(query, max_results=limit)

            for result in search_results:
                href = result.get('href', result.get('link', ''))
                if 'linkedin.com/in/' in href:
                    results.append({
                        'profile_url': href,
                        'name': result.get('title', 'Unknown'),
                        'description': result.get('body', result.get('snippet', ''))
                    })

            return results

        except ImportError:
            print("[!] DuckDuckGo search requires: pip install ddgs")
            print("[!] Falling back to Google search...")
            return self._search_google(query, limit)
        except Exception as e:
            print(f"[!] DuckDuckGo search error: {e}")
            print("[!] Falling back to Google search...")
            return self._search_google(query, limit)

    def _search_google(self, query: str, limit: int) -> List[Dict]:
        """Search using Google"""
        try:
            from bs4 import BeautifulSoup
            from urllib.parse import quote_plus

            encoded_query = quote_plus(query)
            url = f"https://www.google.com/search?q={encoded_query}&num={limit}"

            response = requests.get(url, headers=self.headers, timeout=10)
            response.raise_for_status()

            soup = BeautifulSoup(response.text, 'html.parser')
            results = []
            seen = set()

            for link in soup.find_all('a'):
                href = link.get('href', '')
                if '/url?q=' in href:
                    actual_url = href.split('/url?q=')[1].split('&')[0]
                    if 'linkedin.com/in/' in actual_url and actual_url not in seen:
                        seen.add(actual_url)
                        name = link.get_text(strip=True) or self._extract_name_from_url(actual_url)
                        results.append({
                            'profile_url': actual_url,
                            'name': name,
                            'description': ''
                        })

            return results[:limit]

        except ImportError:
            print("[!] Google search requires: pip install beautifulsoup4")
            return []
        except Exception as e:
            print(f"[!] Google search error: {e}")
            return []

    def _extract_name_from_url(self, url: str) -> str:
        """Extract potential name from LinkedIn URL"""
        match = re.search(r'/in/([a-zA-Z0-9_-]+)', url)
        if match:
            username = match.group(1)
            return username.replace('-', ' ').replace('_', ' ').title()
        return "Unknown"

    def _deduplicate(self, results: List[Dict]) -> List[Dict]:
        """Remove duplicate profiles"""
        unique = []
        seen_urls = set()

        for result in results:
            url = result['profile_url']
            if url not in seen_urls:
                unique.append(result)
                seen_urls.add(url)

        return unique

    def display_terminal(self, results: List[Dict], company: str, location: str):
        """Display results in terminal"""
        print("\n" + "="*80)
        print("LinkedIn Profile Search Results")
        print(f"Company: {company}")
        print(f"Location: {location}")
        print(f"Found: {len(results)} profiles")
        print("="*80 + "\n")

        if not results:
            print("[!] No profiles found. Try:")
            print("  - Broader location terms")
            print("  - Company name variations")
            print("  - Removing special characters")
            return

        for i, result in enumerate(results, 1):
            try:
                name = result.get('name', 'Unknown')
                print(f"{i}. {name}")
                print(f"   URL: {result['profile_url']}")
                if result.get('description'):
                    desc = result['description'][:150]
                    print(f"   Info: {desc}...")
                print()
            except Exception:
                print(f"{i}. {result.get('name', 'Unknown')[:50]}")
                print(f"   URL: {result['profile_url']}")
                print()

    def export_csv(
        self,
        results: List[Dict],
        company: str,
        location: str,
        filename: Optional[str] = None
    ) -> str:
        """Export results to CSV file"""
        if not filename:
            safe_company = company.replace(' ', '_').lower()
            safe_location = location.replace(' ', '_').lower()
            timestamp = datetime.now().strftime("%Y-%m-%d")
            filename = f"{timestamp}_{safe_company}_{safe_location}_{len(results)}_profiles.csv"

        with open(filename, 'w', newline='', encoding='utf-8-sig') as f:
            writer = csv.writer(f)
            writer.writerow(['Name', 'Title', 'LinkedIn URL', 'Description', 'Company', 'Location'])

            for result in results:
                # Extract name without title suffix
                name_parts = result.get('name', '').split(' - ')
                name = name_parts[0].strip()
                title = name_parts[1] if len(name_parts) > 1 else ''

                writer.writerow([
                    name,
                    title,
                    result.get('profile_url', ''),
                    result.get('description', '')[:300],
                    company,
                    location
                ])

        return filename

    def export_pdf(
        self,
        results: List[Dict],
        company: str,
        location: str,
        filename: Optional[str] = None
    ) -> str:
        """Export results to PDF file"""
        try:
            from reportlab.lib import colors
            from reportlab.lib.pagesizes import letter, A4
            from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer
            from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
            from reportlab.lib.units import inch
        except ImportError:
            print("[!] PDF export requires: pip install reportlab")
            return ""

        if not filename:
            safe_company = company.replace(' ', '_').lower()
            safe_location = location.replace(' ', '_').lower()
            timestamp = datetime.now().strftime("%Y-%m-%d")
            filename = f"{timestamp}_{safe_company}_{safe_location}_{len(results)}_profiles.pdf"

        doc = SimpleDocTemplate(filename, pagesize=letter)
        elements = []
        styles = getSampleStyleSheet()

        # Title
        title_style = ParagraphStyle(
            'CustomTitle',
            parent=styles['Heading1'],
            fontSize=24,
            textColor=colors.HexColor('#1a73e8'),
            spaceAfter=30,
        )
        title = Paragraph(f"LinkedIn People Search Results", title_style)
        elements.append(title)

        # Summary
        summary_style = styles['Normal']
        summary = Paragraph(
            f"<b>Company:</b> {company}<br/>"
            f"<b>Location:</b> {location}<br/>"
            f"<b>Total Profiles:</b> {len(results)}<br/>"
            f"<b>Date:</b> {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
            summary_style
        )
        elements.append(summary)
        elements.append(Spacer(1, 0.3*inch))

        # Table data
        table_data = [['#', 'Name', 'LinkedIn Profile']]

        for i, result in enumerate(results, 1):
            name = result.get('name', 'Unknown').split(' - ')[0][:40]
            url = result.get('profile_url', '')[:50]
            table_data.append([str(i), name, url])

        # Create table
        table = Table(table_data, colWidths=[0.5*inch, 2.5*inch, 4*inch])
        table.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#1a73e8')),
            ('TEXTCOLOR', (0, 0), (-1, 0), colors.whitesmoke),
            ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
            ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
            ('FONTSIZE', (0, 0), (-1, 0), 12),
            ('BOTTOMPADDING', (0, 0), (-1, 0), 12),
            ('BACKGROUND', (0, 1), (-1, -1), colors.beige),
            ('GRID', (0, 0), (-1, -1), 1, colors.black),
            ('FONTSIZE', (0, 1), (-1, -1), 9),
            ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, colors.lightgrey]),
        ]))

        elements.append(table)

        # Build PDF
        doc.build(elements)
        return filename


def main():
    """Command-line interface"""
    parser = argparse.ArgumentParser(
        description='Search for people by Company and Location on LinkedIn',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s --company "Google" --location "San Francisco"
  %(prog)s --company "Microsoft" --location "Seattle" --format csv
  %(prog)s --company "Tesla" --location "Austin" --keywords "engineer" --format pdf
  %(prog)s --company "Amazon" --location "New York" --format all
        """
    )

    parser.add_argument('--company', required=True, help='Company name')
    parser.add_argument('--location', required=True, help='Location (city, state, or country)')
    parser.add_argument('--keywords', default='', help='Additional keywords (job titles, skills)')
    parser.add_argument('--format', choices=['terminal', 'csv', 'pdf', 'all'], default='terminal',
                        help='Output format (default: terminal)')
    parser.add_argument('--limit', type=int, default=50, help='Maximum results (default: 50)')
    parser.add_argument('--method', choices=['duckduckgo', 'google'], default='duckduckgo',
                        help='Search method (default: duckduckgo)')

    args = parser.parse_args()

    # Create finder
    finder = PeopleFinder()

    print(f"\n[*] Searching for {args.company} employees in {args.location}...")
    if args.keywords:
        print(f"[*] Keywords: {args.keywords}")
    print(f"[*] Method: {args.method}")
    print("[*] Please wait...\n")

    # Search
    results = finder.search(
        company=args.company,
        location=args.location,
        keywords=args.keywords,
        limit=args.limit,
        method=args.method
    )

    if not results:
        print("[!] No results found.")
        return

    # Output
    if args.format in ['terminal', 'all']:
        finder.display_terminal(results, args.company, args.location)

    if args.format in ['csv', 'all']:
        csv_file = finder.export_csv(results, args.company, args.location)
        print(f"\n[SUCCESS] CSV saved: {csv_file}")

    if args.format in ['pdf', 'all']:
        pdf_file = finder.export_pdf(results, args.company, args.location)
        if pdf_file:
            print(f"[SUCCESS] PDF saved: {pdf_file}")

    print(f"\n[*] Total profiles found: {len(results)}")


if __name__ == "__main__":
    main()
