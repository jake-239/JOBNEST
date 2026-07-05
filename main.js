const JobNest = {
  user: null,
  googleScriptPromise: null,

  protectedPages: new Set([
    "admin-dashboard.html",
    "client-dashboard.html",
    "freelancer-dashboard.html",
    "messages.html",
    "notifications.html",
    "post-job.html",
    "profile.html",
    "saved-jobs.html",
    "settings.html",
    "wallet.html",
  ]),

  loadStoredUser() {
    try {
      this.user = JSON.parse(localStorage.getItem("jobnestUser") || "null");
    } catch (error) {
      localStorage.removeItem("jobnestUser");
      this.user = null;
    }
  },

  saveUser(user) {
    this.user = user;
    localStorage.setItem("jobnestUser", JSON.stringify(user));
    this.renderSession();
  },

  getApiUrl(path) {
    const configuredBase = window.JOBNEST_API_BASE_URL || "";
    if (configuredBase) {
      return `${configuredBase.replace(/\/$/, "")}${path}`;
    }

    const { protocol, hostname, port } = window.location;
    const isLocalHost = hostname === "localhost" || hostname === "127.0.0.1";
    const isStaticLocalPage = protocol === "file:" || (isLocalHost && port && port !== "5000");
    return isStaticLocalPage ? `http://localhost:5000${path}` : path;
  },

  logout() {
    localStorage.removeItem("jobnestUser");
    window.location.href = "login.html";
  },

  async api(path, options = {}) {
    const headers = {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    };

    if (this.user) {
      headers["x-user-id"] = this.user.id;
    }

    let response;
    try {
      response = await fetch(this.getApiUrl(path), { ...options, headers });
    } catch (error) {
      throw new Error("Start the JobNest server with npm start, then open http://localhost:5000.");
    }

    let data = {};
    try {
      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        data = await response.json();
      } else {
        await response.text();
        throw new Error("Start the JobNest server with npm start, then open http://localhost:5000.");
      }
    } catch (error) {
      if (error.message.includes("JobNest server")) throw error;
      throw new Error("The server returned an unreadable response.");
    }

    if (!response.ok) {
      throw new Error(data.error || "Something went wrong.");
    }

    return data;
  },

  flash(message, type = "success") {
    let box = document.querySelector("[data-flash]");
    if (!box) {
      box = document.createElement("div");
      box.setAttribute("data-flash", "");
      box.className = "flash";
      document.querySelector("main")?.prepend(box);
    }
    box.textContent = message;
    box.className = `flash ${type}`;
  },

  formData(form) {
    return Object.fromEntries(new FormData(form).entries());
  },

  getGoogleClientId() {
    const metaClientId = document.querySelector('meta[name="google-client-id"]')?.getAttribute("content") || "";
    return String(window.JOBNEST_GOOGLE_CLIENT_ID || metaClientId).trim();
  },

  loadGoogleIdentityScript() {
    if (window.google?.accounts?.id) return Promise.resolve(true);
    if (this.googleScriptPromise) return this.googleScriptPromise;

    this.googleScriptPromise = new Promise((resolve) => {
      const script = document.createElement("script");
      script.src = "https://accounts.google.com/gsi/client";
      script.async = true;
      script.defer = true;
      script.onload = () => resolve(Boolean(window.google?.accounts?.id));
      script.onerror = () => resolve(false);
      document.head.append(script);
    });

    return this.googleScriptPromise;
  },

  getGoogleAuthContext(element) {
    const explicitContext = element?.getAttribute("data-google-context");
    if (explicitContext) return explicitContext;
    const form = element?.closest("form");
    return form?.matches("[data-signup-form]") ? "signup" : "signin";
  },

  getGoogleRole(element) {
    const form = element?.closest("form") || document.querySelector("[data-signup-form]");
    const role = form?.elements?.role?.value;
    return ["client", "freelancer"].includes(role) ? role : "freelancer";
  },

  async completeGoogleAuth({ credential = "", context = "signin", role = "freelancer" } = {}) {
    const data = await this.api("/api/auth/google", {
      method: "POST",
      body: JSON.stringify({ credential, context, role }),
    });
    this.saveUser(data.user);
    this.redirectForRole();
  },

  bindGoogleAuth() {
    const fallbacks = [...document.querySelectorAll("[data-google-fallback]")];
    const slots = [...document.querySelectorAll("[data-google-button]")];
    if (!fallbacks.length && !slots.length) return;

    slots.forEach((slot) => {
      slot.hidden = true;
    });

    fallbacks.forEach((button) => {
      button.hidden = false;
      button.addEventListener("click", async () => {
        const originalLabel = button.textContent;
        button.disabled = true;
        button.textContent = "Connecting...";
        try {
          await this.completeGoogleAuth({
            context: this.getGoogleAuthContext(button),
            role: this.getGoogleRole(button),
          });
        } catch (error) {
          this.flash(error.message, "error");
        } finally {
          button.disabled = false;
          button.textContent = originalLabel;
        }
      });
    });

    const clientId = this.getGoogleClientId();
    if (!clientId || !slots.length) return;

    this.loadGoogleIdentityScript().then((available) => {
      if (!available) return;

      try {
        window.google.accounts.id.initialize({
          client_id: clientId,
          callback: async (response) => {
            try {
              const target = slots[0];
              await this.completeGoogleAuth({
                credential: response.credential,
                context: this.getGoogleAuthContext(target),
                role: this.getGoogleRole(target),
              });
            } catch (error) {
              this.flash(error.message, "error");
            }
          },
        });

        slots.forEach((slot) => {
          slot.hidden = false;
          window.google.accounts.id.renderButton(slot, {
            theme: "outline",
            size: "large",
            type: "standard",
            shape: "rectangular",
            text: this.getGoogleAuthContext(slot) === "signup" ? "signup_with" : "signin_with",
            width: Math.min(slot.clientWidth || 360, 400),
          });

          const fallback = slot.parentElement?.querySelector("[data-google-fallback]");
          if (fallback) fallback.hidden = true;
        });
      } catch (error) {
        fallbacks.forEach((button) => {
          button.hidden = false;
        });
      }
    });
  },

  escape(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  },

  renderSession() {
    document.querySelectorAll("[data-user-name]").forEach((item) => {
      item.textContent = this.user ? this.user.name : "Guest";
    });

    document.querySelectorAll("[data-auth-only]").forEach((item) => {
      item.hidden = !this.user;
    });

    document.querySelectorAll("[data-guest-only]").forEach((item) => {
      item.hidden = Boolean(this.user);
    });
  },

  getPageName() {
    return window.location.pathname.split("/").pop() || "index.html";
  },

  getSafeNextPage() {
    const next = new URLSearchParams(window.location.search).get("next");
    if (!next || next.includes("/") || !next.endsWith(".html")) return "";
    return next;
  },

  redirectForRole() {
    if (!this.user) {
      window.location.href = "login.html";
      return;
    }

    const next = this.getSafeNextPage();
    if (next) window.location.href = next;
    else if (this.user.role === "client") window.location.href = "client-dashboard.html";
    else if (this.user.role === "admin") window.location.href = "admin-dashboard.html";
    else window.location.href = "freelancer-dashboard.html";
  },

  enforceAuth() {
    const page = this.getPageName();
    if (this.protectedPages.has(page) && !this.user) {
      window.location.href = `login.html?next=${encodeURIComponent(page)}`;
      return false;
    }
    return true;
  },

  async validateSession() {
    if (!this.user) return;

    try {
      const data = await this.api("/api/me");
      if (!data.user) {
        localStorage.removeItem("jobnestUser");
        this.user = null;
      } else {
        this.saveUser(data.user);
      }
    } catch (error) {
      if (this.protectedPages.has(this.getPageName())) {
        this.flash(error.message, "error");
      }
    }
  },

  bindAuth() {
    const signup = document.querySelector("[data-signup-form]");
    if (signup) {
      const role = new URLSearchParams(window.location.search).get("role");
      if (["client", "freelancer"].includes(role) && signup.elements.role) {
        signup.elements.role.value = role;
      }

      signup.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (signup.elements.confirmPassword && signup.elements.password.value !== signup.elements.confirmPassword.value) {
          this.flash("Passwords do not match.", "error");
          return;
        }
        try {
          const data = await this.api("/api/auth/signup", {
            method: "POST",
            body: JSON.stringify(this.formData(signup)),
          });
          this.saveUser(data.user);
          this.redirectForRole();
        } catch (error) {
          this.flash(error.message, "error");
        }
      });
    }

    const login = document.querySelector("[data-login-form]");
    if (login) {
      login.addEventListener("submit", async (event) => {
        event.preventDefault();
        try {
          const data = await this.api("/api/auth/login", {
            method: "POST",
            body: JSON.stringify(this.formData(login)),
          });
          this.saveUser(data.user);
          this.redirectForRole();
        } catch (error) {
          this.flash(error.message, "error");
        }
      });
    }

    document.querySelectorAll("[data-logout]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        this.logout();
      });
    });

    this.bindGoogleAuth();
  },

  bindChooseAccount() {
    document.querySelectorAll("[data-choose-role]").forEach((link) => {
      link.addEventListener("click", (event) => {
        event.preventDefault();
        const role = link.getAttribute("data-choose-role");
        if (this.user) {
          window.location.href = role === "client" ? "client-dashboard.html" : "freelancer-dashboard.html";
          return;
        }
        window.location.href = `signup.html?role=${encodeURIComponent(role)}`;
      });
    });
  },

  async loadHomeStats() {
    const activeJobs = document.querySelector("[data-active-jobs]");
    const freelancers = document.querySelector("[data-freelancers]");
    if (!activeJobs && !freelancers) return;

    try {
      const jobsData = await this.api("/api/jobs");
      activeJobs.textContent = jobsData.jobs.length;
      freelancers.textContent = "1+";
    } catch (error) {
      this.flash(error.message, "error");
    }
  },

  async loadJobs() {
    const list = document.querySelector("[data-jobs-list]");
    if (!list) return;

    try {
      const { jobs } = await this.api("/api/jobs");
      const form = document.querySelector("[data-job-filters]");
      const render = () => {
        const filters = form ? this.formData(form) : {};
        const search = String(filters.search || "").toLowerCase();
        const category = String(filters.category || "");
        const budget = Number(filters.budget || 0);
        const visibleJobs = jobs.filter((job) => {
          const matchesSearch = !search || `${job.title} ${job.description} ${job.category}`.toLowerCase().includes(search);
          const matchesCategory = !category || job.category === category;
          const matchesBudget = !budget || Number(job.budget) >= budget;
          return matchesSearch && matchesCategory && matchesBudget;
        });

        list.innerHTML = visibleJobs.length
          ? visibleJobs
              .map(
                (job) => `
            <article class="card job-card">
              <div>
                <span class="badge">${this.escape(job.category)}</span>
                <h2>${this.escape(job.title)}</h2>
                <p>${this.escape(job.description)}</p>
                <div class="tag-cloud">
                  <span>${this.escape(job.category)}</span>
                  <span>Remote</span>
                  <span>Milestone</span>
                </div>
              </div>
              <div class="job-meta">
                <span><strong>Budget:</strong> $${this.escape(job.budget)}</span>
                <span class="rating">Client rating 4.8</span>
              </div>
              <div class="job-card-footer">
                <span class="muted">${this.escape(job.client?.name || "JobNest client")}</span>
                <a class="button" href="job-details.html?id=${encodeURIComponent(job.id)}">Apply</a>
              </div>
            </article>
          `
              )
              .join("")
          : `<article class="card"><h2>No jobs found</h2><p class="muted">Try changing the search or budget filters.</p></article>`;
      };
      render();
      form?.addEventListener("input", render);
    } catch (error) {
      this.flash(error.message, "error");
    }
  },

  async loadJobDetails() {
    const page = document.querySelector("[data-job-details]");
    if (!page) return;

    try {
      const id = new URLSearchParams(window.location.search).get("id") || "j_react";
      const { jobs } = await this.api("/api/jobs");
      const job = jobs.find((item) => item.id === id) || jobs[0];
      const skills = this.skillsForCategory(job.category);
      const similarJobs = jobs
        .filter((item) => item.id !== job.id)
        .slice(0, 3)
        .map(
          (item) => `
            <article class="card job-card">
              <div>
                <span class="badge">${this.escape(item.category)}</span>
                <h3>${this.escape(item.title)}</h3>
                <p class="muted">${this.escape(item.description)}</p>
              </div>
              <div class="job-card-footer">
                <strong>$${this.escape(item.budget)}</strong>
                <a class="button secondary" href="job-details.html?id=${encodeURIComponent(item.id)}">View</a>
              </div>
            </article>
          `
        )
        .join("");
      page.innerHTML = `
        <div class="page-hero">
          <div>
            <p class="eyebrow">${this.escape(job.category)}</p>
            <h1>${this.escape(job.title)}</h1>
            <p class="lead">${this.escape(job.description)}</p>
            <div class="quick-actions">
              <button class="button" data-apply-job="${this.escape(job.title)}">Apply Now</button>
              <a class="button secondary" href="saved-jobs.html">Save Job</a>
            </div>
          </div>
          <img class="page-hero-image" src="assets/images/jobnest-workspace.svg" alt="JobNest job details workspace illustration">
        </div>
        <section class="two-column">
          <article class="panel">
            <h2>Description</h2>
            <p class="muted">${this.escape(job.description)}</p>
            <h2>Skills required</h2>
            <div class="tag-cloud">${skills.map((skill) => `<span>${this.escape(skill)}</span>`).join("")}</div>
            <h2>Attachments</h2>
            <p class="muted">project-brief.pdf, brand-reference.png</p>
          </article>
          <aside class="panel">
            <h2>Client details</h2>
            <div class="timeline">
              <article><strong>${this.escape(job.client?.name || "JobNest client")}</strong><span class="muted">Verified client / 4.8 rating</span></article>
              <article><strong>Budget</strong><span class="muted">$${this.escape(job.budget)}</span></article>
              <article><strong>Category</strong><span class="muted">${this.escape(job.category)}</span></article>
            </div>
            <a class="button secondary" href="client-profile.html">View Client Profile</a>
          </aside>
        </section>
        <section class="content-section">
          <div class="panel-heading"><p class="eyebrow">Similar jobs</p><h2>More projects like this</h2></div>
          <div class="grid">${similarJobs || `<article class="card"><h3>No similar jobs yet</h3><p class="muted">Check back soon for more opportunities.</p></article>`}</div>
        </section>
      `;
      page.querySelector("[data-apply-job]").addEventListener("click", async () => {
        if (!this.user) {
          window.location.href = "login.html";
          return;
        }
        await this.api("/api/messages", {
          method: "POST",
          body: JSON.stringify({
            subject: `Application sent: ${job.title}`,
            body: `Your application for ${job.title} was recorded.`,
          }),
        });
        this.flash("Application saved in your messages.");
      });
    } catch (error) {
      this.flash(error.message, "error");
    }
  },

  bindPostJob() {
    const form = document.querySelector("[data-post-job-form]");
    if (!form) return;

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        await this.api("/api/jobs", {
          method: "POST",
          body: JSON.stringify(this.formData(form)),
        });
        this.flash("Job published successfully.");
        form.reset();
      } catch (error) {
        this.flash(error.message, "error");
      }
    });
  },

  skillsForCategory(category) {
    const map = {
      "Web Development": ["HTML", "CSS", "JavaScript", "Responsive UI"],
      Design: ["Figma", "Branding", "UI Design", "Prototyping"],
      Writing: ["SEO", "Editing", "Research", "Content Strategy"],
      Marketing: ["Campaigns", "Analytics", "Email", "Copywriting"],
    };
    return map[category] || ["Communication", "Project Planning", "Delivery"];
  },

  bindProfile() {
    const form = document.querySelector("[data-profile-form]");
    if (!form) return;

    if (this.user) {
      form.elements.name.value = this.user.name || "";
      form.elements.role.value = this.user.role || "";
      form.elements.bio.value = this.user.bio || "";
    }

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        const data = await this.api("/api/profile", {
          method: "POST",
          body: JSON.stringify(this.formData(form)),
        });
        this.saveUser(data.user);
        this.flash("Profile saved.");
      } catch (error) {
        this.flash(error.message, "error");
      }
    });
  },

  async loadMessages() {
    const list = document.querySelector("[data-messages-list]");
    if (!list) return;

    try {
      const { messages } = await this.api("/api/messages");
      list.innerHTML = messages.length
        ? messages
            .map((message) => `<article class="conversation-item"><h3>${this.escape(message.subject)}</h3><p class="muted">${this.escape(message.body)}</p></article>`)
            .join("")
        : `<article class="conversation-item"><h3>No messages yet</h3><p class="muted">New replies and applications will appear here.</p></article>`;
    } catch (error) {
      this.flash(error.message, "error");
    }
  },

  bindMessageForm() {
    const form = document.querySelector("[data-message-form]");
    if (!form) return;

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        await this.api("/api/messages", {
          method: "POST",
          body: JSON.stringify(this.formData(form)),
        });
        this.flash("Message sent.");
        form.reset();
        await this.loadMessages();
      } catch (error) {
        this.flash(error.message, "error");
      }
    });
  },

  async loadWallet() {
    const wallet = document.querySelector("[data-wallet]");
    if (!wallet) return;

    try {
      const data = await this.api("/api/wallet");
      wallet.querySelector("[data-wallet-available]").textContent = `$${data.wallet.available}`;
      wallet.querySelector("[data-wallet-pending]").textContent = `$${data.wallet.pending}`;
      wallet.querySelector("[data-wallet-withdrawn]").textContent = `$${data.wallet.withdrawn}`;
    } catch (error) {
      this.flash(error.message, "error");
    }
  },

  async loadDashboard() {
    const client = document.querySelector("[data-client-dashboard]");
    const freelancer = document.querySelector("[data-freelancer-dashboard]");
    const admin = document.querySelector("[data-admin-dashboard]");
    if (!client && !freelancer && !admin) return;

    try {
      if (admin) {
        await this.loadAdminOverview();
        return;
      }

      const { jobs } = await this.api("/api/jobs");
      if (client) {
        client.querySelector("[data-client-open-jobs]").textContent = jobs.length;
        client.querySelector("[data-client-proposals]").textContent = jobs.length * 3;
        client.querySelector("[data-client-pending-jobs]").textContent = Math.max(1, jobs.length - 1);
        client.querySelector("[data-client-hired]").textContent = jobs.length + 5;
      }
      if (freelancer) {
        freelancer.querySelector("[data-freelancer-available-jobs]").textContent = jobs.length;
        freelancer.querySelector("[data-freelancer-applications]").textContent = "1";
        freelancer.querySelector("[data-freelancer-contracts]").textContent = "0";
      }
    } catch (error) {
      this.flash(error.message, "error");
    }
  },

  async loadAdminOverview() {
    const admin = document.querySelector("[data-admin-dashboard]");
    if (!admin) return;

    const data = await this.api("/api/admin/overview");
    admin.querySelector("[data-admin-users]").textContent = data.users.length;
    admin.querySelector("[data-admin-freelancers]").textContent = data.users.filter((user) => user.role === "freelancer").length;
    admin.querySelector("[data-admin-clients]").textContent = data.users.filter((user) => user.role === "client").length;
    admin.querySelector("[data-admin-jobs]").textContent = data.jobs.length;
    admin.querySelector("[data-admin-reports]").textContent = data.messages.length;
    admin.querySelector("[data-admin-payments]").textContent = `$${data.wallet.reduce((total, wallet) => total + Number(wallet.available || 0) + Number(wallet.pending || 0) + Number(wallet.withdrawn || 0), 0)}`;
    const adminMessages = admin.querySelector("[data-admin-messages]");
    if (adminMessages) adminMessages.textContent = data.messages.length;

    admin.querySelector("[data-admin-users-list]").innerHTML = data.users
      .map(
        (user) => `
          <article class="admin-row">
            <div>
              <h3>${this.escape(user.name)}</h3>
              <p class="muted">${this.escape(user.email)} <span class="badge">${this.escape(user.role)}</span></p>
              <p>${this.escape(user.bio || "No bio yet.")}</p>
            </div>
            <div class="row-actions">
              <form class="inline-form" data-admin-role-form="${this.escape(user.id)}">
                <select name="role">
                  <option value="freelancer" ${user.role === "freelancer" ? "selected" : ""}>Freelancer</option>
                  <option value="client" ${user.role === "client" ? "selected" : ""}>Client</option>
                  <option value="admin" ${user.role === "admin" ? "selected" : ""}>Admin</option>
                </select>
                <button class="button secondary" type="submit">Save</button>
              </form>
              <button class="button danger" data-admin-delete-user="${this.escape(user.id)}">Delete</button>
            </div>
          </article>
        `
      )
      .join("");

    admin.querySelector("[data-admin-jobs-list]").innerHTML = data.jobs
      .map(
        (job) => `
          <article class="admin-row">
            <div>
              <h3>${this.escape(job.title)}</h3>
              <p class="muted">${this.escape(job.category)} / $${this.escape(job.budget)} / ${this.escape(job.client?.name || "Unknown client")}</p>
              <p>${this.escape(job.description)}</p>
            </div>
            <div class="row-actions">
              <a class="button secondary" href="job-details.html?id=${encodeURIComponent(job.id)}">View</a>
              <button class="button danger" data-admin-delete-job="${this.escape(job.id)}">Delete</button>
            </div>
          </article>
        `
      )
      .join("");

    admin.querySelector("[data-admin-messages-list]").innerHTML = data.messages.length
      ? data.messages
          .map(
            (message) => `
              <article class="admin-row">
                <div>
                  <h3>${this.escape(message.subject)}</h3>
                  <p class="muted">${this.escape(message.userId)}</p>
                  <p>${this.escape(message.body)}</p>
                </div>
                <button class="button danger" data-admin-delete-message="${this.escape(message.id)}">Delete</button>
              </article>
            `
          )
          .join("")
      : `<article class="card"><h3>No messages</h3><p class="muted">Moderation queue is clear.</p></article>`;

    admin.querySelector("[data-admin-wallet-list]").innerHTML = data.wallet
      .map(
        (wallet) => `
          <article class="admin-row">
            <div>
              <h3>${this.escape(wallet.user?.name || wallet.userId)}</h3>
              <p class="muted">${this.escape(wallet.user?.email || "Unknown user")}</p>
            </div>
            <form class="inline-form" data-admin-wallet-form="${this.escape(wallet.userId)}">
              <input name="available" type="number" value="${this.escape(wallet.available)}" aria-label="Available">
              <input name="pending" type="number" value="${this.escape(wallet.pending)}" aria-label="Pending">
              <input name="withdrawn" type="number" value="${this.escape(wallet.withdrawn)}" aria-label="Withdrawn">
              <button class="button secondary" type="submit">Save</button>
            </form>
          </article>
        `
      )
      .join("");

    this.bindAdminActions(admin);
  },

  bindAdminActions(admin) {
    admin.querySelectorAll("[data-admin-role-form]").forEach((form) => {
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const id = form.getAttribute("data-admin-role-form");
        try {
          await this.api(`/api/admin/users/${encodeURIComponent(id)}`, {
            method: "PATCH",
            body: JSON.stringify(this.formData(form)),
          });
          this.flash("User role updated.");
          await this.loadAdminOverview();
        } catch (error) {
          this.flash(error.message, "error");
        }
      });
    });

    admin.querySelectorAll("[data-admin-wallet-form]").forEach((form) => {
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const userId = form.getAttribute("data-admin-wallet-form");
        try {
          await this.api(`/api/admin/wallet/${encodeURIComponent(userId)}`, {
            method: "PATCH",
            body: JSON.stringify(this.formData(form)),
          });
          this.flash("Wallet updated.");
          await this.loadAdminOverview();
        } catch (error) {
          this.flash(error.message, "error");
        }
      });
    });

    admin.querySelectorAll("[data-admin-delete-user]").forEach((button) => {
      button.addEventListener("click", () => this.adminDelete(`/api/admin/users/${encodeURIComponent(button.dataset.adminDeleteUser)}`, "User deleted."));
    });

    admin.querySelectorAll("[data-admin-delete-job]").forEach((button) => {
      button.addEventListener("click", () => this.adminDelete(`/api/admin/jobs/${encodeURIComponent(button.dataset.adminDeleteJob)}`, "Job deleted."));
    });

    admin.querySelectorAll("[data-admin-delete-message]").forEach((button) => {
      button.addEventListener("click", () => this.adminDelete(`/api/admin/messages/${encodeURIComponent(button.dataset.adminDeleteMessage)}`, "Message deleted."));
    });
  },

  async adminDelete(path, message) {
    if (!confirm("Are you sure?")) return;
    try {
      await this.api(path, { method: "DELETE" });
      this.flash(message);
      await this.loadAdminOverview();
    } catch (error) {
      this.flash(error.message, "error");
    }
  },

  bindContact() {
    const form = document.querySelector("[data-contact-form]");
    if (!form) return;
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      this.flash("Thanks. Your message has been recorded locally.");
      form.reset();
    });
  },

  bindFaqSearch() {
    const search = document.querySelector("[data-faq-search]");
    if (!search) return;

    const questions = [...document.querySelectorAll(".faq-list details")];
    search.addEventListener("input", () => {
      const term = search.value.toLowerCase();
      questions.forEach((item) => {
        item.hidden = term && !item.textContent.toLowerCase().includes(term);
      });
    });
  },

  async init() {
    this.loadStoredUser();

    const year = document.querySelector("[data-year]");
    if (year) year.textContent = new Date().getFullYear();

    await this.validateSession();
    this.renderSession();
    if (!this.enforceAuth()) return;
    this.bindAuth();
    this.bindChooseAccount();
    this.bindPostJob();
    this.bindProfile();
    this.bindContact();
    this.bindMessageForm();
    this.bindFaqSearch();
    this.loadHomeStats();
    this.loadJobs();
    this.loadJobDetails();
    this.loadMessages();
    this.loadWallet();
    this.loadDashboard();
  },
};

document.addEventListener("DOMContentLoaded", () => JobNest.init());
