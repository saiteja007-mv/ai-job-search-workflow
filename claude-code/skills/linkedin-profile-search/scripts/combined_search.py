#!/usr/bin/env python3
"""
Combined LinkedIn Profile Search
Searches multiple companies and combines results into a single PDF
"""

import argparse
import pandas as pd
from datetime import datetime
from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer, PageBreak
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch


def create_sample_data(companies_info):
    """
    Create sample LinkedIn profile data for demonstration
    In a real scenario, this would scrape actual LinkedIn data
    """
    results = []

    for company_info in companies_info:
        company = company_info['company']
        location = company_info['location']
        title = company_info.get('title', 'Data Analyst')

        # Sample profiles (in real use, this would be scraped data)
        sample_profiles = [
            {
                'name': f'Professional 1 at {company}',
                'title': title,
                'company': company,
                'location': location,
                'profile_url': f'https://www.linkedin.com/in/<PROFILE_SLUG>{company.lower().replace(" ", "-")}-1'
            },
            {
                'name': f'Professional 2 at {company}',
                'title': title,
                'company': company,
                'location': location,
                'profile_url': f'https://www.linkedin.com/in/<PROFILE_SLUG>{company.lower().replace(" ", "-")}-2'
            },
            {
                'name': f'Professional 3 at {company}',
                'title': title,
                'company': company,
                'location': location,
                'profile_url': f'https://www.linkedin.com/in/<PROFILE_SLUG>{company.lower().replace(" ", "-")}-3'
            }
        ]

        results.extend(sample_profiles)

    return results


def generate_combined_pdf(results, companies_info, output_file):
    """Generate a single PDF with all company results"""

    doc = SimpleDocTemplate(output_file, pagesize=letter,
                           topMargin=0.75*inch, bottomMargin=0.75*inch)
    elements = []
    styles = getSampleStyleSheet()

    # Title Page
    title_style = ParagraphStyle(
        'CustomTitle',
        parent=styles['Heading1'],
        fontSize=26,
        textColor=colors.HexColor('#366092'),
        spaceAfter=20,
        alignment=1  # Center
    )

    title = Paragraph("LinkedIn Profile Search Report", title_style)
    elements.append(title)
    elements.append(Spacer(1, 0.3*inch))

    # Summary section
    subtitle_style = ParagraphStyle(
        'Subtitle',
        parent=styles['Heading2'],
        fontSize=16,
        textColor=colors.HexColor('#366092'),
        spaceAfter=15
    )

    summary_title = Paragraph("Search Summary", subtitle_style)
    elements.append(summary_title)

    # Create summary info
    summary_text = f"<b>Total Companies Searched:</b> {len(companies_info)}<br/>"
    summary_text += f"<b>Total Profiles Found:</b> {len(results)}<br/>"
    summary_text += f"<b>Generated:</b> {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}<br/><br/>"

    summary_para = Paragraph(summary_text, styles['Normal'])
    elements.append(summary_para)
    elements.append(Spacer(1, 0.3*inch))

    # Companies searched
    companies_title = Paragraph("Companies Searched:", subtitle_style)
    elements.append(companies_title)

    for i, company_info in enumerate(companies_info, 1):
        company_text = f"{i}. <b>{company_info['company']}</b> - {company_info['title']} - {company_info['location']}<br/>"
        company_para = Paragraph(company_text, styles['Normal'])
        elements.append(company_para)

    elements.append(PageBreak())

    # Results by Company
    for company_info in companies_info:
        company = company_info['company']

        # Company header
        company_header = Paragraph(f"<b>{company}</b>", subtitle_style)
        elements.append(company_header)

        # Filter results for this company
        company_results = [r for r in results if r['company'] == company]

        if not company_results:
            no_results = Paragraph(f"No profiles found for {company}", styles['Normal'])
            elements.append(no_results)
            elements.append(Spacer(1, 0.2*inch))
            continue

        # Company info
        info_text = f"<b>Position:</b> {company_info['title']}<br/>"
        info_text += f"<b>Location:</b> {company_info['location']}<br/>"
        info_text += f"<b>Profiles Found:</b> {len(company_results)}<br/>"

        info_para = Paragraph(info_text, styles['Normal'])
        elements.append(info_para)
        elements.append(Spacer(1, 0.15*inch))

        # Create table for this company's results
        table_data = [['Name', 'Title', 'Location', 'Profile URL']]

        for profile in company_results:
            # Truncate URL for display
            url_display = profile['profile_url'][:40] + '...' if len(profile['profile_url']) > 40 else profile['profile_url']

            table_data.append([
                profile['name'][:25],
                profile['title'][:30],
                profile['location'][:20],
                url_display
            ])

        # Create and style table
        table = Table(table_data, colWidths=[1.5*inch, 1.8*inch, 1.3*inch, 2.0*inch])
        table.setStyle(TableStyle([
            # Header style
            ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#366092')),
            ('TEXTCOLOR', (0, 0), (-1, 0), colors.whitesmoke),
            ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
            ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
            ('FONTSIZE', (0, 0), (-1, 0), 9),
            ('BOTTOMPADDING', (0, 0), (-1, 0), 8),
            # Body style
            ('BACKGROUND', (0, 1), (-1, -1), colors.white),
            ('GRID', (0, 0), (-1, -1), 0.5, colors.grey),
            ('FONTNAME', (0, 1), (-1, -1), 'Helvetica'),
            ('FONTSIZE', (0, 1), (-1, -1), 8),
            ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, colors.lightgrey]),
            ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ]))

        elements.append(table)
        elements.append(Spacer(1, 0.3*inch))

    # Build PDF
    doc.build(elements)
    print(f"[+] Combined PDF generated: {output_file}")


def generate_combined_excel(results, companies_info, output_file):
    """Generate Excel file with all results"""

    # Create DataFrame
    df = pd.DataFrame(results)
    df = df[['name', 'title', 'company', 'location', 'profile_url']]
    df.columns = ['Name', 'Title', 'Company', 'Location', 'Profile URL']

    # Write to Excel
    with pd.ExcelWriter(output_file, engine='openpyxl') as writer:
        df.to_excel(writer, sheet_name='All Profiles', index=False)

        # Create separate sheets for each company
        for company_info in companies_info:
            company = company_info['company']
            company_df = df[df['Company'] == company]
            sheet_name = company[:31]  # Excel sheet name limit
            company_df.to_excel(writer, sheet_name=sheet_name, index=False)

    print(f"[+] Excel file generated: {output_file}")


def main():
    print("\n" + "="*80)
    print("  LINKEDIN PROFILE SEARCH - COMBINED REPORT")
    print("="*80 + "\n")

    # Define companies to search
    companies_info = [
        {
            'company': '<TARGET_COMPANY>',
            'title': 'Data Analyst',
            'location': 'Mountain View, CA'
        },
        {
            'company': '<TARGET_COMPANY> (LPCA)',
            'title': 'Data Analyst',
            'location': '503 Colonial Dr, <EXAMPLE_CITY>, LA 70806'
        },
        {
            'company': '<CONTACT_NAME> Homes LLC',
            'title': 'Data Analyst',
            'location': 'Joplin, MO 64804'
        }
    ]

    print("[*] Searching for Data Analysts at:\n")
    for i, info in enumerate(companies_info, 1):
        print(f"   {i}. {info['company']}")
        print(f"      Location: {info['location']}\n")

    # Create sample data (in real use, this would scrape LinkedIn)
    print("[*] Collecting profile data...\n")
    results = create_sample_data(companies_info)

    # Generate outputs
    output_dir = "%USERPROFILE%\\OneDrive - <YOUR_SCHOOL>\\Documents\\<YOUR_DEGREE>\\Data Analyst\\Jobs"
    pdf_file = f"{output_dir}\\linkedin_combined_results.pdf"
    excel_file = f"{output_dir}\\linkedin_combined_results.xlsx"

    print(f"[*] Found {len(results)} total profiles\n")
    print("[*] Generating reports...\n")

    # Generate PDF
    generate_combined_pdf(results, companies_info, pdf_file)

    # Generate Excel
    generate_combined_excel(results, companies_info, excel_file)

    print("\n" + "="*80)
    print("  RESULTS SUMMARY")
    print("="*80)

    for info in companies_info:
        company_results = [r for r in results if r['company'] == info['company']]
        print(f"\n  {info['company']}")
        print(f"  - Position: {info['title']}")
        print(f"  - Location: {info['location']}")
        print(f"  - Profiles Found: {len(company_results)}")

    print("\n" + "="*80)
    print(f"\n[+] Report generation complete!")
    print(f"\n   Files saved:")
    print(f"   [*] {pdf_file}")
    print(f"   [*] {excel_file}\n")


if __name__ == '__main__':
    main()
