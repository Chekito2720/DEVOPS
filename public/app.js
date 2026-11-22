"use strict";

const $ = (id) => document.getElementById(id);
const priceFormatter = new Intl.NumberFormat("es-MX", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const dateFormatter = new Intl.DateTimeFormat("es-MX", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});
const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (character) => {
    const ampersand = String.fromCodePoint(38);
    const entities = {
      "&": `${ampersand}amp;`,
      "<": `${ampersand}lt;`,
      ">": `${ampersand}gt;`,
      '"': `${ampersand}quot;`,
      "'": `${ampersand}#39;`,
    };
    return entities[character];
  });

function formatDate(value) {
  try {
    return dateFormatter.format(new Date(`${String(value).replace(" ", "T")}Z`));
  } catch (_error) {
    return String(value ?? "");
  }
}

let token = sessionStorage.getItem("token");
let currentUser = null;
let users = [];
let products = [];
let categories = [];
let orders = [];
let editingUser = null;
let editingProduct = null;

function setLogged(logged) {
  $("login-view").classList.toggle("hidden", logged);
  $("app-view").classList.toggle("hidden", !logged);
}

function showTab(tabName) {
  const tabs = {
    users: ["users-view", "tab-users"],
    products: ["products-view", "tab-products"],
    categories: ["categories-view", "tab-categories"],
    orders: ["orders-view", "tab-orders"],
  };

  Object.entries(tabs).forEach(([name, [viewId, tabId]]) => {
    const selected = name === tabName;
    $(viewId).classList.toggle("hidden", !selected);
    $(tabId).classList.toggle("active", selected);
    $(tabId).setAttribute("aria-selected", String(selected));
  });
}

function notify(message = "", type = "") {
  const element = $("msg");
  element.textContent = message;
  element.className = `message ${type}`.trim();
}

function logout(message = "") {
  token = null;
  currentUser = null;
  sessionStorage.removeItem("token");
  users = [];
  products = [];
  categories = [];
  orders = [];
  resetUserForm();
  resetProductForm();
  setLogged(false);
  showTab("users");
  notify("");
  $("login-error").textContent = message;
  $("email").focus();
}

async function api(method, url, body) {
  const response = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const payload = await response.json().catch(() => ({}));

  if (response.status === 401 && token) {
    logout("La sesión expiró o ya no es válida. Inicia sesión nuevamente.");
  }

  if (!response.ok) {
    throw new Error(payload.error || `Error HTTP ${response.status}`);
  }

  return payload.data;
}

function resetUserForm() {
  editingUser = null;
  $("users-form").reset();
  $("u-rol").value = "user";
  $("u-rol").disabled = false;
  $("btn-user-save").textContent = "Guardar usuario";
  $("btn-user-cancel").classList.add("hidden");
}

function resetProductForm() {
  editingProduct = null;
  $("products-form").reset();
  $("p-stock").value = "0";
  $("p-categoria").value = "";
  $("btn-prod-save").textContent = "Guardar producto";
  $("btn-prod-cancel").classList.add("hidden");
}

function renderUsers() {
  const tbody = $("users-table").querySelector("tbody");
  if (!users.length) {
    tbody.innerHTML = '<tr><td class="empty-row" colspan="5">No hay usuarios.</td></tr>';
    return;
  }

  tbody.innerHTML = users
    .map((user) => {
      const isCurrentUser = String(user.id) === String(currentUser?.id);
      return `
        <tr>
          <td>${escapeHtml(user.id)}</td>
          <td>${escapeHtml(user.nombre)}</td>
          <td>${escapeHtml(user.email)}</td>
          <td>${escapeHtml(user.rol)}</td>
          <td>
            <button class="button u-edit" data-id="${user.id}" type="button">Editar</button>
            <button class="button danger u-del" data-id="${user.id}" type="button" ${isCurrentUser ? "disabled title=\"No puedes eliminar tu propio usuario\"" : ""}>Eliminar</button>
          </td>
        </tr>`;
    })
    .join("");
}

function renderProducts() {
  const tbody = $("products-table").querySelector("tbody");
  if (!products.length) {
    tbody.innerHTML = '<tr><td class="empty-row" colspan="6">No hay productos.</td></tr>';
    return;
  }

  tbody.innerHTML = products
    .map(
      (product) => `
        <tr>
          <td>${escapeHtml(product.id)}</td>
          <td>${escapeHtml(product.nombre)}</td>
          <td>$${escapeHtml(priceFormatter.format(Number(product.precio)))}</td>
          <td>${escapeHtml(product.stock)}</td>
          <td>${escapeHtml(product.categoria || "Sin categoría")}</td>
          <td>
            <button class="button p-edit" data-id="${product.id}" type="button">Editar</button>
            <button class="button danger p-del" data-id="${product.id}" type="button">Eliminar</button>
          </td>
        </tr>`
    )
    .join("");
}

function renderCategories() {
  const tbody = $("categories-table").querySelector("tbody");
  tbody.innerHTML = categories.length
    ? categories
        .map(
          (category) => `
            <tr>
              <td>${escapeHtml(category.id)}</td>
              <td>${escapeHtml(category.nombre)}</td>
              <td>
                <button class="button danger c-del" data-id="${category.id}" type="button">Eliminar</button>
              </td>
            </tr>`
        )
        .join("")
    : '<tr><td class="empty-row" colspan="3">No hay categorías.</td></tr>';
}

function renderOrders() {
  const tbody = $("orders-table").querySelector("tbody");
  tbody.innerHTML = orders.length
    ? orders
        .map(
          (order) => `
            <tr>
              <td>${escapeHtml(order.id)}</td>
              <td>${escapeHtml(order.producto)}</td>
              <td>${escapeHtml(order.cantidad)}</td>
              <td>${escapeHtml(formatDate(order.fecha))}</td>
            </tr>`
        )
        .join("")
    : '<tr><td class="empty-row" colspan="4">No hay pedidos.</td></tr>';
}

function renderCategoryOptions() {
  const selected = $("p-categoria").value;
  $("p-categoria").innerHTML =
    '<option value="">Sin categoría</option>' +
    categories
      .map((category) => `<option value="${category.id}">${escapeHtml(category.nombre)}</option>`)
      .join("");
  $("p-categoria").value = selected;
}

function renderProductOptions() {
  $("o-producto").innerHTML = products
    .map((product) => `<option value="${product.id}">${escapeHtml(product.nombre)}</option>`)
    .join("");
}

async function loadUsers() {
  users = await api("GET", "/api/users");
  renderUsers();
}

async function loadProducts() {
  products = await api("GET", "/api/productos");
  renderProducts();
  renderProductOptions();
}

async function loadCategories() {
  categories = await api("GET", "/api/categorias");
  renderCategories();
  renderCategoryOptions();
}

async function loadOrders() {
  orders = await api("GET", "/api/pedidos");
  renderOrders();
}

function tokenPayload() {
  if (!token) return null;
  try {
    const encodedPayload = token.split(".")[1];
    const base64 = encodedPayload
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(encodedPayload.length / 4) * 4, "=");
    return JSON.parse(atob(base64));
  } catch (_error) {
    return null;
  }
}

function tokenRole() {
  return tokenPayload()?.rol || null;
}

async function start(user) {
  const payload = tokenPayload();
  currentUser = user || currentUser || (payload ? {
    id: payload.id,
    email: payload.email,
    rol: payload.rol,
  } : null);
  const role = currentUser?.rol || tokenRole();
  const isAdmin = role === "admin";

  if (currentUser) {
    const identity = [currentUser.nombre, currentUser.email].filter(Boolean).join(" · ");
    $("who").textContent = identity;
  }
  $("tab-users").classList.toggle("hidden", !isAdmin);
  setLogged(true);
  showTab(isAdmin ? "users" : "products");

  const requests = [loadProducts(), loadCategories(), loadOrders()];
  if (isAdmin) requests.push(loadUsers());
  await Promise.all(requests);
}

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("login-error").textContent = "";

  try {
    const data = await api("POST", "/api/auth/login", {
      email: $("email").value,
      password: $("password").value,
    });
    token = data.token;
    currentUser = data.user;
    sessionStorage.setItem("token", token);
    $("password").value = "";
    await start(data.user);
  } catch (error) {
    if (token) logout(error.message);
    else $("login-error").textContent = error.message;
  }
});

$("btn-logout").addEventListener("click", logout);
$("tab-users").addEventListener("click", () => showTab("users"));
$("tab-products").addEventListener("click", () => showTab("products"));
$("tab-categories").addEventListener("click", () => showTab("categories"));
$("tab-orders").addEventListener("click", () => showTab("orders"));

// ---------- Usuarios ----------

$("users-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = $("u-password").value;
  if (!editingUser && !password) {
    notify("La contraseña es obligatoria para crear un usuario.", "error");
    $("u-password").focus();
    return;
  }

  const body = {
    nombre: $("u-nombre").value,
    email: $("u-email").value,
    rol: $("u-rol").value,
  };
  if (password) body.password = password;

  try {
    if (editingUser) {
      await api("PUT", `/api/users/${editingUser}`, body);
    } else {
      await api("POST", "/api/users", body);
    }
    resetUserForm();
    notify("Usuario guardado correctamente.", "success");
    await loadUsers();
  } catch (error) {
    notify(error.message, "error");
  }
});

$("btn-user-cancel").addEventListener("click", resetUserForm);

$("users-table").addEventListener("click", async (event) => {
  const id = event.target.dataset.id;
  if (!id) return;

  if (event.target.classList.contains("u-edit")) {
    const user = users.find((item) => String(item.id) === id);
    if (!user) return;
    editingUser = user.id;
    $("u-nombre").value = user.nombre;
    $("u-email").value = user.email;
    $("u-rol").value = user.rol;
    $("u-rol").disabled = String(user.id) === String(currentUser?.id);
    $("u-password").value = "";
    $("btn-user-save").textContent = "Guardar cambios";
    $("btn-user-cancel").classList.remove("hidden");
  }

  if (event.target.classList.contains("u-del")) {
    try {
      await api("DELETE", `/api/users/${id}`);
      notify("Usuario eliminado.", "success");
      await loadUsers();
    } catch (error) {
      notify(error.message, "error");
    }
  }
});

// ---------- Productos ----------

$("products-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const rawName = $("p-nombre").value.trim();
  const rawPrice = $("p-precio").value.trim();
  const rawStock = $("p-stock").value.trim();

  if (!rawName) {
    notify("El nombre del producto es obligatorio.", "error");
    $("p-nombre").focus();
    return;
  }
  if (!rawPrice) {
    notify("El precio del producto es obligatorio.", "error");
    $("p-precio").focus();
    return;
  }

  const category = $("p-categoria").value;
  const body = {
    nombre: rawName,
    precio: Number(rawPrice),
    stock: rawStock === "" ? 0 : Number(rawStock),
    categoria_id: category ? Number(category) : null,
  };

  try {
    if (editingProduct) {
      await api("PUT", `/api/productos/${editingProduct}`, body);
    } else {
      await api("POST", "/api/productos", body);
    }
    resetProductForm();
    notify("Producto guardado correctamente.", "success");
    await loadProducts();
  } catch (error) {
    notify(error.message, "error");
  }
});

$("btn-prod-cancel").addEventListener("click", resetProductForm);

$("products-table").addEventListener("click", async (event) => {
  const id = event.target.dataset.id;
  if (!id) return;

  if (event.target.classList.contains("p-edit")) {
    const product = products.find((item) => String(item.id) === id);
    if (!product) return;
    editingProduct = product.id;
    $("p-nombre").value = product.nombre;
    $("p-precio").value = product.precio;
    $("p-stock").value = product.stock;
    $("p-categoria").value = product.categoria_id ?? "";
    $("btn-prod-save").textContent = "Guardar cambios";
    $("btn-prod-cancel").classList.remove("hidden");
  }

  if (event.target.classList.contains("p-del")) {
    try {
      await api("DELETE", `/api/productos/${id}`);
      notify("Producto eliminado.", "success");
      await loadProducts();
    } catch (error) {
      notify(error.message, "error");
    }
  }
});

// ---------- Categorias ----------

$("categories-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("POST", "/api/categorias", { nombre: $("c-nombre").value });
    $("c-nombre").value = "";
    notify("Categoría guardada.", "success");
    await loadCategories();
  } catch (error) {
    notify(error.message, "error");
  }
});

$("categories-table").addEventListener("click", async (event) => {
  const id = event.target.dataset.id;
  if (!id || !event.target.classList.contains("c-del")) return;
  try {
    await api("DELETE", `/api/categorias/${id}`);
    notify("Categoría eliminada.", "success");
    await loadCategories();
  } catch (error) {
    notify(error.message, "error");
  }
});

// ---------- Pedidos ----------

$("orders-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("POST", "/api/pedidos", {
      producto_id: Number($("o-producto").value),
      cantidad: Number($("o-cantidad").value),
    });
    $("o-cantidad").value = "1";
    notify("Pedido guardado.", "success");
    await loadOrders();
  } catch (error) {
    notify(error.message, "error");
  }
});

async function verifyApi() {
  try {
    const response = await fetch("/api/health");
    const payload = await response.json();
    if (
      !response.ok ||
      payload.statusCode !== 200 ||
      payload.error ||
      payload.data?.status !== "ok"
    ) {
      throw new Error("health check failed");
    }
    $("api-status").textContent = "API disponible";
    $("api-status").classList.add("ok");
  } catch (_error) {
    $("api-status").textContent = "API no disponible";
    $("api-status").classList.remove("ok");
  }
}

verifyApi();

if (token) {
  start(null).catch((error) => logout(error.message));
} else {
  setLogged(false);
}
