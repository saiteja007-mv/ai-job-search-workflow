#!/usr/bin/env python3
"""Test script for job role LinkedIn search"""

import sys
sys.path.insert(0, '%USERPROFILE%\\.claude\\skills\\linkedin-profile-search\\scripts')

from job_role_linkedin_search import search_relevant_contacts, generate_enhanced_pdf, generate_enhanced_excel
from datetime import datetime
from pathlib import Path

# Configuration for testing
job_role = "Data Analyst"

companies_info = [
    {
        'company': '<TARGET_COMPANY>',
        'location': 'Mountain View, CA',
        'title': job_role
    },
    {
        'company': '<TARGET_COMPANY>',
        'location': '<EXAMPLE_CITY>, LA',
        'title': job_role
    },
    {
        'company': '<CONTACT_NAME> Homes',
        'location': 'Joplin, MO',
        'title': job_role
    }
]

print(f"\nSearching for contacts relevant to {job_role} position...")
print("="*80)

# Search
results = search_relevant_contacts(companies_info, job_role, limit_per_search=10)

if not results:
    print("\n[!] No contacts found.")
    sys.exit(1)

# Generate reports
output_dir = Path("%USERPROFILE%/OneDrive - <YOUR_SCHOOL>/Documents/<YOUR_DEGREE>/Data Analyst/Jobs")
output_dir.mkdir(parents=True, exist_ok=True)

timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
pdf_file = output_dir / f"linkedin_contacts_{job_role.replace(' ', '_')}_{timestamp}.pdf"
excel_file = output_dir / f"linkedin_contacts_{job_role.replace(' ', '_')}_{timestamp}.xlsx"

print("\n" + "="*80)
print("  GENERATING REPORTS")
print("="*80 + "\n")

generate_enhanced_pdf(results, companies_info, job_role, str(pdf_file))
generate_enhanced_excel(results, companies_info, job_role, str(excel_file))

# Summary
print("\n" + "="*80)
print("  FINAL SUMMARY")
print("="*80)
print(f"\nTarget Role: {job_role}")
print(f"Total Contacts: {len(results)}")

role_types = {}
for r in results:
    role_type = r.get('role_type', 'Other')
    role_types[role_type] = role_types.get(role_type, 0) + 1

print("\nBreakdown by Type:")
for role_type, count in sorted(role_types.items(), key=lambda x: x[1], reverse=True):
    print(f"  - {role_type}: {count} contacts")

print("\nBy Company:")
for info in companies_info:
    company_results = [r for r in results if r['company'] == info['company']]
    print(f"  - {info['company']}: {len(company_results)} contacts")

print("\n" + "="*80)
print(f"\n[+] Files saved:")
print(f"   [*] {pdf_file.name}")
print(f"   [*] {excel_file.name}\n")
