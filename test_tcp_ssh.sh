#!/bin/bash

echo "SSH over HTTP2 Tunnel Test (Custom TCP Wrapper)"
echo "==============================================="

# Function to cleanup processes
cleanup() {
    echo "Cleaning up processes..."
    kill $SSH_SERVER_PID $TCP_CLIENT_PID $SUB_PID $PUB_PID 2>/dev/null
    exit
}

# Set trap for cleanup
trap cleanup EXIT INT TERM

echo "Step 1: Starting SSH Server on port 2222..."
node test/ssh/ssh_server.js > /tmp/ssh_tcp.log 2>&1 &
SSH_SERVER_PID=$!
sleep 2

echo "Step 2: Starting pub server..."
node pub/index.js > /tmp/pub_tcp.log 2>&1 &
PUB_PID=$!
sleep 3

echo "Step 3: Starting sub client..."
PUB_URL=https://127.0.0.1:5001/sub/pub SUB_CONFIG=./config.json node sub/index.js > /tmp/sub_tcp.log 2>&1 &
SUB_PID=$!
sleep 3

echo "Step 4: Starting TCP wrapper client..."
# TCP wrapper connects to pub WebSocket server and forwards to SSH server
# Use path /wspub/ssh/-/ to match the "ssh" config entry
node tcp_wrapper/tcp_client.js 2223 127.0.0.1 2222 ws://127.0.0.1:5002/wspub/ssh/-/ > /tmp/tcp_client.log 2>&1 &
TCP_CLIENT_PID=$!
sleep 3

echo ""
echo "All services started:"
echo "- SSH Server: 127.0.0.1:2222"
echo "- Pub HTTP2 Server: 127.0.0.1:5001"
echo "- Pub WebSocket Server: 127.0.0.1:5002"
echo "- Sub Client: connected to Pub (HTTP2)"
echo "- TCP Wrapper: 127.0.0.1:2223 -> Pub (WS) -> Sub -> SSH Server"

echo ""
echo "Testing SSH connection..."
sleep 2

# Test SSH connection
echo "Attempting SSH connection..."
timeout 15s ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 -p 2223 test@127.0.0.1 'echo "SSH SUCCESS via HTTP2 TCP wrapper!"; date; whoami' || echo "SSH test failed"

echo ""
echo "Checking service logs..."

echo "=== SSH Server Log ==="
tail -5 /tmp/ssh_tcp.log 2>/dev/null || echo "No SSH server log"

echo "=== TCP Client Log ==="
tail -10 /tmp/tcp_client.log 2>/dev/null || echo "No TCP client log"

echo "=== Pub Server Log (non-204) ==="
grep -v "204" /tmp/pub_tcp.log | tail -10 2>/dev/null || echo "No pub log"

echo "=== Sub Client Log ==="
tail -10 /tmp/sub_tcp.log 2>/dev/null || echo "No sub log"

echo ""
echo "Press Enter to exit..."
read -r
