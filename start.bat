@echo off
echo Starting Quan ly cua hang...
echo.
echo Starting Backend...
start cmd /k "cd backend && npm install && npm run init-db && npm run dev"
timeout /t 3
echo.
echo Starting Frontend...
start cmd /k "cd frontend && npm install && npm run dev"
echo.
echo Both servers are starting...
echo Backend: http://localhost:5000
echo Frontend: http://localhost:3000
pause

