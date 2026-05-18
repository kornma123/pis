Get-ChildItem -Path "e2e" -Filter "*.spec.ts" | ForEach-Object {
    $file = $_.FullName
    $content = Get-Content -Path $file -Raw
    $original = $content
    
    # Replace BASE_URL from localhost:3000 to localhost:8080 (frontend)
    $content = $content -replace "const BASE_URL = 'http://localhost:3000'", "const BASE_URL = 'http://localhost:8080'"
    
    # Replace API fetch URLs using BASE_URL template
    $content = $content -replace '\$\{BASE_URL\}/api/v1', 'http://localhost:3001/api/v1'
    
    if ($content -ne $original) {
        Set-Content -Path $file -Value $content -NoNewline
        Write-Host "Updated: $($_.Name)"
    }
}
Write-Host "Done!"
