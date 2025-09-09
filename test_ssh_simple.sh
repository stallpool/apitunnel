#!/bin/bash

echo "SSH over HTTP2 Tunnel Test (Simplified)"
echo "======================================="

# Function to cleanup processes
cleanup() {
    echo "Cleaning up processes..."
    kill $SSH_SERVER_PID $WSTUNNEL_SERVER_PID $SUB_PID $PUB_PID $WSTUNNEL_CLIENT_PID 2>/dev/null
    exit
}

# Set trap for cleanup
trap cleanup EXIT INT TERM

echo "Step 1: Starting SSH Server on port 2222..."
node test/ssh/ssh_server.js > /tmp/ssh_server.log 2>&1 &
SSH_SERVER_PID=$!
sleep 2

echo "Step 2: Starting wstunnel server on port 8080 -> SSH server..."
./node_modules/.bin/wstunnel -s 0.0.0.0:8080 -t 127.0.0.1:2222 > /tmp/wstunnel_server.log 2>&1 &
WSTUNNEL_SERVER_PID=$!
sleep 2

echo "Step 3: Starting pub server..."
node pub/index.js > /tmp/pub.log 2>&1 &
PUB_PID=$!
sleep 3

echo "Step 4: Starting sub client..."
PUB_URL=https://127.0.0.1:5001/sub/pub SUB_CONFIG=./config.json node sub/index.js > /tmp/sub.log 2>&1 &
SUB_PID=$!
sleep 3

echo "Step 5: Starting wstunnel client..."
# Use WebSocket connection to pub WebSocket server on port 5002
./node_modules/.bin/wstunnel -c -t 127.0.0.1:2223:127.0.0.1:8080 ws://127.0.0.1:5002/wspub/127.0.0.1:8080/-/ > /tmp/wstunnel_client.log 2>&1 &
WSTUNNEL_CLIENT_PID=$!
sleep 5

echo ""
echo "All services started:"
echo "- SSH Server: 127.0.0.1:2222"
echo "- wstunnel Server: 127.0.0.1:8080 -> SSH Server"
echo "- Pub HTTP2 Server: 127.0.0.1:5001"
echo "- Pub WebSocket Server: 127.0.0.1:5002"
echo "- Sub Client: connected to Pub (HTTP2)"
echo "- wstunnel Client: 127.0.0.1:2223 -> Pub (WS:5002) -> Sub -> wstunnel Server -> SSH"

echo ""
echo "Testing SSH connection..."
sleep 2

# Test with a simple command
echo "Attempting SSH connection with command execution..."
timeout 15s ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 -p 2223 test@127.0.0.1 'echo "SSH tunnel working!"; date' || echo "SSH test failed"

echo ""
echo "Checking service logs..."

echo "=== SSH Server Log ==="
tail -n 5 /tmp/ssh_server.log 2>/dev/null || echo "No SSH server log"

echo "=== wstunnel Server Log ==="
tail -n 5 /tmp/wstunnel_server.log 2>/dev/null || echo "No wstunnel server log"

echo "=== wstunnel Client Log ==="
tail -n 5 /tmp/wstunnel_client.log 2>/dev/null || echo "No wstunnel client log"

echo "=== Pub Server Log (non-204) ==="
grep -v "204" /tmp/pub.log | tail -n 10 2>/dev/null || echo "No pub log"

echo "=== Sub Client Log ==="
tail -n 5 /tmp/sub.log 2>/dev/null || echo "No sub log"

echo ""
echo "Press Enter to exit..."
read -r
