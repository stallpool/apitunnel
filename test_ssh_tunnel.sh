#!/bin/bash

echo "SSH over HTTP2 Tunnel Test"
echo "=========================="

# Check if all required files exist
if [ ! -f "certs/server.key" ] || [ ! -f "certs/server.crt" ]; then
    echo "Error: SSL certificates not found in certs/ directory"
    exit 1
fi

if [ ! -f "config.json" ]; then
    echo "Creating test config.json..."
    cp config.example.json config.json
fi

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

echo "Step 2: Starting wstunnel server (WebSocket server) on port 8080..."
# wstunnel server that connects to SSH server
./node_modules/.bin/wstunnel -s 0.0.0.0:8080 -t 127.0.0.1:2222 > /tmp/wstunnel_server.log 2>&1 &
WSTUNNEL_SERVER_PID=$!
sleep 2

echo "Step 3: Starting pub server (HTTP2)..."
node pub/index.js > /tmp/pub.log 2>&1 &
PUB_PID=$!
sleep 3

echo "Step 4: Starting sub client..."
PUB_URL=https://127.0.0.1:5001/sub/pub SUB_CONFIG=./config.json node sub/index.js > /tmp/sub.log 2>&1 &
SUB_PID=$!
sleep 3

echo "Step 5: Starting wstunnel client..."
# wstunnel client connects to pub server via HTTPS, forwards local port 2223 to the tunnel
./node_modules/.bin/wstunnel -c -t 127.0.0.1:2223:127.0.0.1:8080 https://127.0.0.1:5001/wspub/127.0.0.1:8080/-/ > /tmp/wstunnel_client.log 2>&1 &
WSTUNNEL_CLIENT_PID=$!
sleep 3

echo "All components started!"
echo "- SSH Server: port 2222"
echo "- wstunnel Server: port 8080 -> SSH Server"
echo "- Pub Server: HTTPS port 5001"
echo "- Sub Client: connected to Pub"
echo "- wstunnel Client: port 2223 -> Pub -> Sub -> wstunnel Server -> SSH Server"

echo ""
echo "Testing SSH connection through the tunnel..."
echo "Tunnel path: ssh client -> wstunnel client (port 2223) -> pub (HTTPS) -> sub -> wstunnel server (port 8080) -> SSH server (port 2222)"
echo ""

# Wait a bit more for everything to be ready
sleep 5

echo "Testing with SSH command..."
echo "Running: ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p 2223 test@127.0.0.1"
echo ""

# Test SSH connection
timeout 10s ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=5 -p 2223 test@127.0.0.1 'echo "SSH tunnel test successful!"; date; echo "Connection working through HTTP2 pub/sub tunnel!"' || echo "SSH connection failed or timed out"

echo ""
echo "Test completed. Check logs for details:"
echo "- SSH Server: /tmp/ssh_server.log"
echo "- wstunnel Server: /tmp/wstunnel_server.log"
echo "- Pub Server: /tmp/pub.log"
echo "- Sub Client: /tmp/sub.log"
echo "- wstunnel Client: /tmp/wstunnel_client.log"

echo ""
echo "Press Enter to see recent logs, or Ctrl+C to exit..."
read -r

echo "=== Recent SSH Server Log ==="
tail -n 10 /tmp/ssh_server.log 2>/dev/null || echo "No SSH server log"

echo "=== Recent wstunnel Server Log ==="
tail -n 10 /tmp/wstunnel_server.log 2>/dev/null || echo "No wstunnel server log"

echo "=== Recent Pub Log ==="
tail -n 10 /tmp/pub.log 2>/dev/null || echo "No pub log"

echo "=== Recent Sub Log ==="
tail -n 10 /tmp/sub.log 2>/dev/null || echo "No sub log"

echo "=== Recent wstunnel Client Log ==="
tail -n 10 /tmp/wstunnel_client.log 2>/dev/null || echo "No wstunnel client log"
