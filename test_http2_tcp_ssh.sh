#!/bin/bash

echo "SSH over HTTP2 TCP Tunnel Test (Native HTTP2)"
echo "============================================="

# Function to cleanup processes
cleanup() {
    echo "Cleaning up processes..."
    kill $SSH_SERVER_PID $HTTP2_TCP_CLIENT_PID $SUB_PID $PUB_PID 2>/dev/null
    exit
}

# Set trap for cleanup
trap cleanup EXIT INT TERM

echo "Step 1: Starting SSH Server on port 2222..."
node test/ssh/ssh_server.js > /tmp/ssh_http2_tcp.log 2>&1 &
SSH_SERVER_PID=$!
sleep 2

echo "Step 2: Starting pub server..."
node pub/index.js > /tmp/pub_http2_tcp.log 2>&1 &
PUB_PID=$!
sleep 3

echo "Step 3: Starting sub client..."
PUB_URL=https://127.0.0.1:5001/sub/pub SUB_CONFIG=./config.json node sub/index.js > /tmp/sub_http2_tcp.log 2>&1 &
SUB_PID=$!
sleep 3

echo "Step 4: Starting HTTP2 TCP wrapper client..."
# HTTP2 TCP wrapper connects directly to pub server via HTTP2
node tcp_wrapper/tcp_http2_client.js 2224 127.0.0.1 2222 https://127.0.0.1:5001 > /tmp/http2_tcp_client.log 2>&1 &
HTTP2_TCP_CLIENT_PID=$!
sleep 3

echo ""
echo "All services started:"
echo "- SSH Server: 127.0.0.1:2222"
echo "- Pub HTTP2 Server: 127.0.0.1:5001"
echo "- Pub WebSocket Server: 127.0.0.1:5002 (for compatibility)"
echo "- Sub Client: connected to Pub (HTTP2)"
echo "- HTTP2 TCP Wrapper: 127.0.0.1:2224 -> Pub (HTTP2) -> Sub -> SSH Server"

echo ""
echo "Testing SSH connection via HTTP2 TCP tunnel..."
sleep 2

# Test SSH connection
echo "Attempting SSH connection..."
timeout 15s ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 -p 2224 test@127.0.0.1 'echo "SSH SUCCESS via HTTP2 TCP tunnel!"; date; whoami' || echo "SSH test failed"

echo ""
echo "Testing WebSocket compatibility (old method)..."
echo "Starting WebSocket TCP client for comparison..."

# Also test the old WebSocket method to ensure it still works
timeout 10s node tcp_wrapper/tcp_client.js 2225 127.0.0.1 2222 ws://127.0.0.1:5002/wspub/ssh/-/ > /tmp/ws_tcp_client.log 2>&1 &
WS_TCP_CLIENT_PID=$!
sleep 3

echo "Attempting SSH via WebSocket tunnel..."
timeout 15s ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 -p 2225 test@127.0.0.1 'echo "SSH SUCCESS via WebSocket tunnel!"; date; whoami' || echo "WebSocket SSH test failed"

kill $WS_TCP_CLIENT_PID 2>/dev/null

echo ""
echo "Checking service logs..."

echo "=== SSH Server Log ==="
tail -5 /tmp/ssh_http2_tcp.log 2>/dev/null || echo "No SSH server log"

echo "=== HTTP2 TCP Client Log ==="
tail -10 /tmp/http2_tcp_client.log 2>/dev/null || echo "No HTTP2 TCP client log"

echo "=== WebSocket TCP Client Log ==="
tail -5 /tmp/ws_tcp_client.log 2>/dev/null || echo "No WebSocket TCP client log"

echo "=== Pub Server Log (non-204) ==="
grep -v "204" /tmp/pub_http2_tcp.log | tail -15 2>/dev/null || echo "No pub log"

echo "=== Sub Client Log ==="
tail -10 /tmp/sub_http2_tcp.log 2>/dev/null || echo "No sub log"

echo ""
echo "Press Enter to exit..."
read -r
