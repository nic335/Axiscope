@echo off
setlocal EnableDelayedExpansion

:: Set colors for better visibility
color 0A

:: Show welcome message
echo ================================
echo Welcome to AxiScope Setup
echo ================================
echo.

:: Check if Python is installed and get its version
for /f "tokens=*" %%i in ('python --version 2^>^&1') do set PYTHON_VERSION=%%i

:: If Python is not found, PYTHON_VERSION will contain the error message
echo !PYTHON_VERSION! | findstr /C:"Python" >nul
if errorlevel 1 (
    echo Python is not found on your system.
    echo Would you like to install Python now? [Y/N]
    set /p INSTALL_CHOICE="Choice: "
    if /i "!INSTALL_CHOICE!"=="Y" (
        echo.
        echo Downloading Python installer...
        
        :: Use latest Python 3.11 which is stable and widely supported
        set "PYTHON_URL=https://www.python.org/ftp/python/3.11.7/python-3.11.7-amd64.exe"
        set "INSTALLER=%TEMP%\python_installer.exe"
        
        :: Download with progress using PowerShell
        powershell -NoProfile -Command "$ProgressPreference = 'SilentlyContinue'; Invoke-WebRequest -Uri '%PYTHON_URL%' -OutFile '%INSTALLER%'
        
        if exist "%INSTALLER%" (
            echo Download complete.
            echo Installing Python...
            echo This may take a few minutes...
            
            :: Install Python with key features enabled
            start /wait %INSTALLER% /quiet InstallAllUsers=1 PrependPath=1 Include_test=0 Include_pip=1
            
            :: Verify installation
            python --version >nul 2>&1
            if errorlevel 1 (
                color 0C
                echo.
                echo ERROR: Python installation failed.
                echo Please try installing Python manually from https://www.python.org/downloads/
                echo.
                pause
                exit /b 1
            ) else (
                echo.
                echo Python installed successfully!
                echo.
            )
            
            :: Clean up
            del /q "%INSTALLER%" >nul 2>&1
        ) else (
            color 0C
            echo Failed to download Python installer.
            echo Please check your internet connection or install Python manually.
            pause
            exit /b 1
        )
    ) else (
        color 0C
        echo.
        echo Python is required to run Axiscope.
        echo Please install Python from https://www.python.org/downloads/
        echo.
        pause
        exit /b 1
    )
) else (
    echo Found: !PYTHON_VERSION!
)

echo.
echo Starting AxisScope...
echo.

:: Change to the Axiscope directory and start the server


:: Try to start the server on port 3000
echo Starting the web server on http://localhost:3000
echo Press Ctrl+C to stop the server
echo.

python -m http.server 3000

:: If server fails to start
if errorlevel 1 (
    color 0C
    echo.
    echo Failed to start the web server.
    echo Please make sure port 3000 is not in use.
    echo.
    pause
)
