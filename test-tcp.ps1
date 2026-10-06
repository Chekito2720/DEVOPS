param(
    [string]$Server = "18.116.163.41",
    [int]$Port = 6061
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
        Start-Sleep -Milliseconds 800
        $buffer = New-Object byte[] 8192
        $read = $stream.Read($buffer, 0, $buffer.Length)
        $respuesta = [Text.Encoding]::UTF8.GetString($buffer, 0, $read).Trim()

        $client.Close()

        Write-Host "Respuesta: $respuesta" -ForegroundColor Green
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

Enviar-Tcp '{insert:{"nombre":"Mause","precio":250,"categoria_id":1}}' "INSERT producto"
Enviar-Tcp '{get:{"id":7}}'   "GET producto insertado (id 7)"
Enviar-Tcp '{get:{"id":1}}'   "GET producto del seed (id 1)"
Enviar-Tcp '{get:{"id":999}}' "GET producto inexistente (404)"
Enviar-Tcp '{delete:{"id":1}}'  "Comando no reconocido (400)"

Write-Host "`nPruebas terminadas." -ForegroundColor Cyan
