#!/bin/bash

echo "Testing HTTP2 Tunnel Setup"
echo "=========================="

# Check if certificates exist
if [ ! -f "certs/server.key" ] || [ ! -f "certs/server.crt" ]; then
    echo "Error: SSL certificates not found in certs/ directory"
    echo "Please run the setup first to generate certificates"
    exit 1
fi

# Create test config if it doesn't exist
if [ ! -f "config.json" ]; then
    echo "Creating test config.json..."
    cp config.example.json config.json
fi

echo "1. Starting HTTP2 test server on port 5102..."
node test/http2/http2server.js &
SERVER_PID=$!
sleep 2

echo "2. Starting pub server..."
node pub/index.js &
PUB_PID=$!
sleep 3

echo "3. Starting sub client..."
PUB_URL=https://127.0.0.1:5001/sub/pub SUB_CONFIG=./config.json node sub/index.js &
SUB_PID=$!
sleep 3

echo "4. Testing HTTP2 client connection..."
node test/http2/http2client.js &
CLIENT_PID=$!
sleep 5

echo "5. Cleaning up processes..."
kill $CLIENT_PID 2>/dev/null
kill $SUB_PID 2>/dev/null
kill $PUB_PID 2>/dev/null
kill $SERVER_PID 2>/dev/null

echo "Test completed!"
echo "Check the output above to verify HTTP2 communication is working."
