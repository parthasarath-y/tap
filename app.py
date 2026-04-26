# app.py - FIXED VERSION with proper color/BW page logic

from flask import Flask, request, jsonify
from flask_cors import CORS
import os
import fitz  # PyMuPDF for PDF
from werkzeug.utils import secure_filename
from docx import Document
from pptx import Presentation
from PIL import Image

app = Flask(__name__)
CORS(app)

UPLOAD_FOLDER = 'uploads'
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER

ALLOWED_EXTENSIONS = {
    'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
    'png', 'jpg', 'jpeg', 'gif', 'bmp', 'txt', 'rtf', 'odt', 'ods', 'odp'
}

# Pricing (in rupees)
COLOR_PRICE_PER_PAGE = 10.5
BW_PRICE_PER_PAGE = 1.5

def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

def get_page_count(filepath):
    """Get accurate page count for different file types"""
    ext = os.path.splitext(filepath)[1].lower().lstrip('.')
    try:
        if ext == 'pdf':
            with fitz.open(filepath) as doc:
                return doc.page_count

        elif ext in ('docx', 'doc'):
            doc = Document(filepath)
            # Count explicit page breaks
            page_breaks = sum(1 for paragraph in doc.paragraphs
                              if paragraph._p.xpath('.//w:br[@w:type="page"]'))
            return max(1, page_breaks + 1)

        elif ext in ('pptx', 'ppt'):
            prs = Presentation(filepath)
            return len(prs.slides)

        elif ext in ('xlsx', 'xls'):
            # For Excel, count sheets
            try:
                import openpyxl
                wb = openpyxl.load_workbook(filepath)
                return len(wb.sheetnames)
            except:
                return 1

        elif ext in ('jpg', 'jpeg', 'png', 'gif', 'bmp'):
            with Image.open(filepath) as img:
                return getattr(img, 'n_frames', 1)

        else:
            return 1
    except Exception as e:
        print(f" Page count failed for {filepath}: {e}")
        return 1

@app.route('/api/upload', methods=['POST'])
def upload_files():
    if 'files' not in request.files:
        return jsonify({'success': False, 'message': 'No files provided'}), 400

    files = request.files.getlist('files')
    options_str = request.form.get('options')

    if not options_str:
        return jsonify({'success': False, 'message': 'No options provided'}), 400

    try:
        import json
        options = json.loads(options_str)
    except json.JSONDecodeError:
        return jsonify({'success': False, 'message': 'Invalid options format'}), 400

    if len(files) != len(options):
        return jsonify({'success': False, 'message': 'Files and options count mismatch'}), 400

    results = []
    grand_total = 0

    for file, opt in zip(files, options):
        if file.filename == '':
            continue

        if not allowed_file(file.filename):
            results.append({
                'name': file.filename,
                'success': False,
                'message': 'Invalid file type'
            })
            continue

        filename = secure_filename(file.filename)
        file_path = os.path.join(app.config['UPLOAD_FOLDER'], filename)
        file.save(file_path)

        page_count = get_page_count(file_path)

        print_type = opt.get('printType', 'bw')
        copies = opt.get('copies', 1)
        pages_str = opt.get('pages', 'all')

        color_pages = 0
        bw_pages = page_count

        # CORRECTED LOGIC for color page ranges
        if print_type == 'color' and pages_str != 'all':
            try:
                # Parse range "4-20"
                fr, to = map(int, pages_str.split('-'))
                
                if fr >= 1 and to <= page_count and fr <= to:
                    # Example: 20-page doc, from=4, to=20
                    # Color pages: 20-4+1 = 17 (pages 4,5,6...20)
                    # B&W pages: (4-1) + (20-20) = 3 (pages 1,2,3)
                    
                    color_pages = to - fr + 1
                    bw_pages = (fr - 1) + (page_count - to)
                    
                    print(f" {filename}: Total={page_count}, Range={fr}-{to}")
                    print(f"   Color: {color_pages} pages, B&W: {bw_pages} pages")
                else:
                    print(f" Invalid range {pages_str} for {filename} ({page_count} pages)")
                    # Fallback to all B&W
                    color_pages = 0
                    bw_pages = page_count
            except Exception as e:
                print(f" Range parsing error for {filename}: {e}")
                # Fallback to all B&W
                color_pages = 0
                bw_pages = page_count

        # Calculate prices
        color_price = color_pages * copies * COLOR_PRICE_PER_PAGE
        bw_price = bw_pages * copies * BW_PRICE_PER_PAGE
        file_total = color_price + bw_price

        grand_total += file_total

        results.append({
            'name': filename,
            'original_name': opt.get('name', filename),
            'pageCount': page_count,
            'colorPages': color_pages,
            'bwPages': bw_pages,
            'copies': copies,
            'printType': print_type,
            'pages': pages_str,
            'fileTotal': round(file_total, 2),
            'success': True
        })

    return jsonify({
        'success': True,
        'message': f'{len(results)} file(s) processed successfully',
        'files': results,
        'grandTotal': round(grand_total, 2)
    }), 200

@app.route('/api/health', methods=['GET'])
def health_check():
    return jsonify({'status': 'ok', 'message': 'Server is running'}), 200

if __name__ == '__main__':
    print(" Starting TakeAprinT server on http://localhost:3000")
    print(" Upload folder:", os.path.abspath(UPLOAD_FOLDER))
    app.run(debug=True, port=3000)