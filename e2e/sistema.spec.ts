import { test, expect, Page, APIRequestContext } from "@playwright/test";

const ADMIN = { email: "admin@demo.com", password: "Admin123!" };

async function login(
  page: Page,
  email = ADMIN.email,
  password = ADMIN.password
): Promise<void> {
  await page.goto("/");
  await page.fill("#email", email);
  await page.fill("#password", password);
  await page.click("#btn-login");
}

async function tokenOf(request: APIRequestContext): Promise<string> {
  const response = await request.post("/api/auth/login", { data: ADMIN });
  expect(response.status()).toBe(200);
  const payload = await response.json();
  return payload.data.token as string;
}

function uniqueEmail(prefix = "e2e"): string {
  return `${prefix}${Date.now()}${Math.floor(Math.random() * 1000)}@demo.com`;
}

test.describe("Login (UI)", () => {
  test("credenciales invalidas muestran un error", async ({ page }) => {
    await login(page, ADMIN.email, "incorrecta");
    await expect(page.locator("#login-error")).toHaveText("Credenciales invalidas");
    await expect(page.locator("#app-view")).toBeHidden();
  });

  test("un usuario normal no ve la administracion de usuarios", async ({
    page,
    request,
  }) => {
    const adminToken = await tokenOf(request);
    const email = uniqueEmail("ui-normal");
    const created = await request.post("/api/users", {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: { nombre: "Usuario normal UI", email, password: "secreto1" },
    });
    expect(created.status()).toBe(201);

    await login(page, email, "secreto1");
    await expect(page.locator("#app-view")).toBeVisible();
    await expect(page.locator("#tab-users")).toBeHidden();
    await expect(page.locator("#tab-products")).toBeVisible();
  });

  test("login valido abre el sistema y cerrar sesion vuelve al login", async ({
    page,
  }) => {
    await login(page);
    await expect(page.locator("#app-view")).toBeVisible();
    await expect(page.locator("#who")).toContainText(ADMIN.email);
    await page.click("#btn-logout");
    await expect(page.locator("#login-view")).toBeVisible();
    await expect(page.locator("#app-view")).toBeHidden();
  });

  test("la sesion valida se conserva despues de recargar", async ({ page }) => {
    await login(page);
    await expect(page.locator("#app-view")).toBeVisible();

    await page.reload();

    await expect(page.locator("#app-view")).toBeVisible();
    await expect(page.locator("#who")).toContainText(ADMIN.email);
    await page.click("#tab-products");
    await expect(page.locator("#products-table tbody tr").first()).toBeVisible();
  });
});

test.describe("CRUD usuarios (UI)", () => {
  test("crear, editar y eliminar un usuario", async ({ page }) => {
    const email = uniqueEmail();
    await login(page);
    await expect(page.locator("#app-view")).toBeVisible();

    await page.fill("#u-nombre", "Usuario E2E");
    await page.fill("#u-email", email);
    await page.fill("#u-password", "secreto1");
    await page.click("#btn-user-save");

    const row = page.locator("#users-table tbody tr", { hasText: email });
    await expect(row).toBeVisible();

    await row.locator(".u-edit").click();
    await page.fill("#u-nombre", "Usuario E2E editado");
    await page.click("#btn-user-save");
    await expect(
      page.locator("#users-table tbody tr", { hasText: "Usuario E2E editado" })
    ).toBeVisible();

    await page
      .locator("#users-table tbody tr", { hasText: email })
      .locator(".u-del")
      .click();
    await expect(
      page.locator("#users-table tbody tr", { hasText: email })
    ).toHaveCount(0);
  });

  test("email duplicado muestra error", async ({ page }) => {
    await login(page);
    await page.fill("#u-nombre", "Duplicado");
    await page.fill("#u-email", ADMIN.email);
    await page.fill("#u-password", "secreto1");
    await page.click("#btn-user-save");
    await expect(page.locator("#msg")).toHaveText("El email ya existe");
  });
});

test.describe("CRUD productos (UI)", () => {
  test("crear, editar y eliminar un producto", async ({ page }) => {
    const name = `Producto E2E ${Date.now()}`;
    await login(page);
    await page.click("#tab-products");
    await page.fill("#p-nombre", name);
    await page.fill("#p-precio", "49.5");
    await page.fill("#p-stock", "10");
    await page.click("#btn-prod-save");

    const row = page.locator("#products-table tbody tr", { hasText: name });
    await expect(row).toBeVisible();
    await expect(row).toContainText("10");

    await row.locator(".p-edit").click();
    await page.fill("#p-precio", "60");
    await page.fill("#p-stock", "7");
    await page.click("#btn-prod-save");
    await expect(
      page.locator("#products-table tbody tr", { hasText: name })
    ).toContainText("60");
    await expect(
      page.locator("#products-table tbody tr", { hasText: name })
    ).toContainText("7");

    await page
      .locator("#products-table tbody tr", { hasText: name })
      .locator(".p-del")
      .click();
    await expect(
      page.locator("#products-table tbody tr", { hasText: name })
    ).toHaveCount(0);
  });

  test("precio negativo se rechaza y no crea el producto", async ({ page }) => {
    await login(page);
    await page.click("#tab-products");
    await page.fill("#p-nombre", "Producto invalido");
    await page.fill("#p-precio", "-5");
    await page.fill("#p-stock", "1");

    expect(
      await page
        .locator("#p-precio")
        .evaluate((element) => (element as HTMLInputElement).validity.rangeUnderflow)
    ).toBe(true);
    await page.click("#btn-prod-save");
    await expect(
      page.locator("#products-table tbody tr", { hasText: "Producto invalido" })
    ).toHaveCount(0);
  });

  test("un precio vacio se rechaza y no crea el producto", async ({ page }) => {
    await login(page);
    await page.click("#tab-products");
    await page.fill("#p-nombre", "Producto sin precio");
    await page.fill("#p-precio", "");
    await page.fill("#p-stock", "1");

    expect(
      await page
        .locator("#p-precio")
        .evaluate((element) => (element as HTMLInputElement).validity.valueMissing)
    ).toBe(true);
    await page.click("#btn-prod-save");
    await expect(
      page.locator("#products-table tbody tr", { hasText: "Producto sin precio" })
    ).toHaveCount(0);
  });
});

test.describe("Categorias y pedidos (UI)", () => {
  test("crea y elimina una categoria", async ({ page }) => {
    const categoryName = `Categoria E2E ${Date.now()}`;
    await login(page);
    await page.click("#tab-categories");
    await page.fill("#c-nombre", categoryName);
    await page.click("#btn-cat-save");

    const row = page.locator("#categories-table tbody tr", { hasText: categoryName });
    await expect(row).toBeVisible();
    await row.locator(".c-del").click();
    await expect(
      page.locator("#categories-table tbody tr", { hasText: categoryName })
    ).toHaveCount(0);
  });

  test("crea un pedido con un producto existente", async ({ page }) => {
    await login(page);
    await page.click("#tab-orders");
    const orderRows = page.locator("#orders-table tbody tr");
    const initialCount = await orderRows.count();

    await page.selectOption("#o-producto", { index: 0 });
    await page.fill("#o-cantidad", "2");
    await page.click("#btn-order-save");

    await expect(orderRows).toHaveCount(initialCount + 1);
    await expect(orderRows.last()).toContainText("2");
  });
});

test.describe("API (backend)", () => {
  test("health responde 200 con el esquema completo", async ({ request }) => {
    const response = await request.get("/api/health");
    expect(response.status()).toBe(200);
    const payload = await response.json();
    expect(Object.keys(payload).sort()).toEqual([
      "data",
      "path",
      "request",
      "responseTime",
      "statusCode",
      "timestamp",
    ]);
    expect(payload).toEqual(
      expect.objectContaining({
        statusCode: 200,
        responseTime: expect.any(Number),
        request: "GET",
        path: "/api/health",
        timestamp: expect.any(String),
      })
    );
    expect(payload.data.status).toBe("ok");
    expect(payload).not.toHaveProperty("error");
  });

  test("rutas protegidas sin token responden 401", async ({ request }) => {
    const users = await request.get("/api/users");
    const products = await request.get("/api/productos");
    expect(users.status()).toBe(401);
    expect(products.status()).toBe(401);
    expect((await users.json()).error).toBe("Token requerido");
  });

  test("login sin cuerpo responde 400 y clave incorrecta 401", async ({
    request,
  }) => {
    expect((await request.post("/api/auth/login", { data: {} })).status()).toBe(
      400
    );
    expect(
      (
        await request.post("/api/auth/login", {
          data: { email: ADMIN.email, password: "incorrecta" },
        })
      ).status()
    ).toBe(401);
  });

  test("flujo CRUD de productos por API", async ({ request }) => {
    const headers = { Authorization: `Bearer ${await tokenOf(request)}` };
    const created = await request.post("/api/productos", {
      headers,
      data: { nombre: "Producto API", precio: 10, stock: 1 },
    });
    expect(created.status()).toBe(201);
    const payload = await created.json();
    const id = payload.data.id as number;
    expect(payload.data.stock).toBe(1);

    const updated = await request.put(`/api/productos/${id}`, {
      headers,
      data: { precio: 12 },
    });
    expect(updated.status()).toBe(200);
    const updatedPayload = await updated.json();
    expect(updatedPayload.data.precio).toBe(12);
    expect(updatedPayload.data.stock).toBe(1);

    const detail = await request.get(`/api/productos/${id}`, { headers });
    expect(detail.status()).toBe(200);
    expect((await detail.json()).data.stock).toBe(1);

    const deleted = await request.delete(`/api/productos/${id}`, { headers });
    expect(deleted.status()).toBe(200);
    expect((await request.get(`/api/productos/${id}`, { headers })).status()).toBe(
      404
    );
  });

  test("flujo CRUD de usuarios por API", async ({ request }) => {
    const headers = { Authorization: `Bearer ${await tokenOf(request)}` };
    const created = await request.post("/api/users", {
      headers,
      data: {
        nombre: "Usuario API",
        email: uniqueEmail("api"),
        password: "secreto1",
      },
    });
    expect(created.status()).toBe(201);
    const payload = await created.json();
    const id = payload.data.id as number;

    const updated = await request.put(`/api/users/${id}`, {
      headers,
      data: { nombre: "Usuario API editado" },
    });
    expect(updated.status()).toBe(200);
    expect((await updated.json()).data.nombre).toBe("Usuario API editado");

    const deleted = await request.delete(`/api/users/${id}`, { headers });
    expect(deleted.status()).toBe(200);
  });

  test("validaciones: id invalido 400, inexistente 404 y password corta 400", async ({
    request,
  }) => {
    const headers = { Authorization: `Bearer ${await tokenOf(request)}` };
    expect(
      (await request.get("/api/productos/abc", { headers })).status()
    ).toBe(400);
    expect(
      (await request.get("/api/productos/99999", { headers })).status()
    ).toBe(404);
    const invalidUser = await request.post("/api/users", {
      headers,
      data: { nombre: "X", email: uniqueEmail("short"), password: "123" },
    });
    expect(invalidUser.status()).toBe(400);
  });
});
