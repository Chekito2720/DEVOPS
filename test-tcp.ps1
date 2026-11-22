param(
    [string]$Server = "127.0.0.1",
    [int]$Port = 6061,
    [switch]$Insert
)

function Enviar-Tcp {
    param(
        [string]$Mensaje,
        [string]$Descripcion
    )

    Write-Host "`n=== $Descripcion ===" -ForegroundColor Cyan
    Write-Host "Enviando : $Mensaje" -ForegroundColor DarkGray

    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $client.Connect($Server, $Port)

        $stream = $client.GetStream()
        $bytes = [Text.Encoding]::UTF8.GetBytes("$Mensaje`n")
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush()

        # Esperar la respuesta del servidor
        Start-Sleep -Milliseconds 300
        $buffer = New-Object byte[] 8192
        $read = $stream.Read($buffer, 0, $buffer.Length)
        $respuesta = [Text.Encoding]::UTF8.GetString($buffer, 0, $read).Trim()

        $client.Close()

        Write-Host "Respuesta: $respuesta" -ForegroundColor Green
        return $respuesta
    }
    catch {
        Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
        Write-Host "Verifica que el contenedor este corriendo y que el puerto $Port este abierto en el Security Group." -ForegroundColor Yellow
        exit 1
    }
}

Write-Host "============================================"
Write-Host " Pruebas TCP contra ${Server}:$Port"
Write-Host "============================================"

if ($Insert) {
    # La insercion es explicita porque modifica la base de datos conectada.
    $insertResponse = Enviar-Tcp '{insert:{"nombre":"Mause","precio":250,"stock":1}}' "INSERT producto"
    try {
        $inserted = $insertResponse | ConvertFrom-Json
        if ($inserted.statusCode -eq 200 -and $inserted.data.id) {
            Enviar-Tcp "{get:{\`"id\`":$($inserted.data.id)}}" "GET producto insertado" | Out-Null
        }
    }
    catch {
        Write-Host "No se pudo interpretar la respuesta del INSERT." -ForegroundColor Yellow
        exit 1
    }
}
else {
    Write-Host "Solo lectura. Usa -Insert únicamente contra una base de pruebas." -ForegroundColor Yellow
}

Enviar-Tcp '{get:{"id":1}}' "GET producto del seed (id 1)" | Out-Null
Enviar-Tcp '{get:{"id":999}}' "GET producto inexistente (404)" | Out-Null
Enviar-Tcp '{delete:{"id":1}}' "Comando no reconocido (400)" | Out-Null

Write-Host "`nPruebas terminadas." -ForegroundColor Cyan
