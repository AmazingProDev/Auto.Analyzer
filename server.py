import http.server
import socketserver
import json
import csv
import os

PORT = 8000

class CustomHandler(http.server.SimpleHTTPRequestHandler):
    def do_POST(self):
        if self.path == '/save_sites':
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            
            try:
                data = json.loads(post_data.decode('utf-8'))
                
                # Verify data is a list of dicts
                if not isinstance(data, list):
                     raise ValueError("Expected a list of site objects")

                output_file = "sites_updated.csv"
                
                if len(data) > 0:
                    # Specific headers requested by User
                    desired_headers = [
                        'eNodeB ID-Cell ID', 'eNodeB ID', 'Site Name', 'Cell Name', 'Cell ID',
                        'Physical cell ID', 'Downlink EARFCN', 'Uplink EARFCN',
                        'Tracking area code', 'Latitude', 'Longitude', 'Azimut'
                    ]

                    mapped_data = []
                    for item in data:
                        # Helper to safely get values from item (which contains all original + parsed keys)
                        
                        # 1. eNodeB ID-Cell ID
                        # Prefer 'rawEnodebCellId' if present, otherwise look for variants
                        raw_id = item.get('rawEnodebCellId')
                        if not raw_id:
                            raw_id = item.get('eNodeB ID-Cell ID') or item.get('eNodeB ID-Cell ID'.lower()) or ''
                        
                        # 2. eNodeB ID
                        # Extract from raw_id if possible
                        enb_id = item.get('eNodeB ID')
                        if not enb_id and raw_id and '-' in str(raw_id):
                             enb_id = str(raw_id).split('-')[0]
                        if not enb_id: enb_id = ''

                        new_row = {
                            'eNodeB ID-Cell ID': raw_id,
                            'eNodeB ID': enb_id,
                            'Site Name': item.get('siteName', item.get('Site Name', '')),
                            'Cell Name': item.get('cellName', item.get('Cell Name', '')),
                            'Cell ID': item.get('cellId', item.get('Cell ID', '')),
                            'Physical cell ID': item.get('pci', item.get('Physical cell ID', '')),
                            'Downlink EARFCN': item.get('freq', item.get('Downlink EARFCN', '')),
                            'Uplink EARFCN': item.get('Uplink EARFCN', ''), # Pass-through
                            'Tracking area code': item.get('Tracking area code', ''), # Pass-through
                            'Latitude': item.get('lat', item.get('Latitude', '')),
                            'Longitude': item.get('lng', item.get('Longitude', '')),
                            'Azimut': item.get('azimuth', item.get('Azimut', ''))
                        }
                        mapped_data.append(new_row)
                    
                    with open(output_file, 'w', newline='', encoding='utf-8') as csvfile:
                        writer = csv.DictWriter(csvfile, fieldnames=desired_headers, extrasaction='ignore')
                        writer.writeheader()
                        writer.writerows(mapped_data)
                else:
                    # Empty file if no data
                    open(output_file, 'w').close()
                
                self.send_response(200)
                self.send_header('Content-type', 'application/json')
                self.end_headers()
                response = {"status": "success", "message": f"Saved to {output_file}"}
                self.wfile.write(json.dumps(response).encode('utf-8'))
                print(f"Successfully saved {len(data)} rows to {output_file}")

            except Exception as e:
                print(f"Error saving sites: {e}")
                self.send_response(500)
                self.send_header('Content-type', 'application/json')
                self.end_headers()
                response = {"status": "error", "message": str(e)}
                self.wfile.write(json.dumps(response).encode('utf-8'))
        else:
            self.send_error(404)

print(f"Starting server on port {PORT}...")
print("Use Ctrl+C to stop.")

with socketserver.TCPServer(("", PORT), CustomHandler) as httpd:
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping server.")
        httpd.server_close()
