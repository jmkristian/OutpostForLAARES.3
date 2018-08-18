@cd "%~dp0"
@if not exist logs mkdir logs
start "Open a Message" /MIN bin\launch.exe %*
@rem For development or debugging, it's convenient to install Node.js and do this instead:
@rem node bin/launch.js %*
@rem pause
