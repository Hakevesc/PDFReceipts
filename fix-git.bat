@echo off
cd /d C:\Users\LEGION\Documents\GitHub\PDFReceipts
if exist .git rmdir /S /Q .git
if exist nul del nul 2>nul
git init
git config user.email hakevesc@gmail.com
git config user.name Hakevesc
echo .env > .gitignore
git add -A
git commit -m "M-PESA PDF Receipts - Business & Customer variants, 2-col index"
git branch -M main
git remote add origin https://github.com/Hakevesc/PDFReceipts.git 2>nul
git push -u origin main --force
pause