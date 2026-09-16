import { canonicalSiteKey } from "../../core/contracts.mjs";
import { ChangefeedError } from "../../core/errors.mjs";
import { normalizeResourceLocator } from "../../core/normalize.mjs";

export const REQUIRED_FUNCTIONS = Object.freeze([
  "core_webservice_get_site_info",
  "core_enrol_get_users_courses",
  "core_course_get_contents"
]);

export const OPTIONAL_FUNCTIONS = Object.freeze([
  "core_calendar_get_calendar_events",
  "mod_assign_get_assignments",
  "mod_forum_get_forums_by_courses",
  "mod_forum_get_forum_discussions",
  "mod_quiz_get_quizzes_by_courses"
]);

const CAPABILITY_UNAVAILABLE_ERROR_CODES = new Set([
  "wsfunctionnotavailable",
  "servicenotavailable",
  "notavailable",
  "accessdenied",
  "accessexception"
]);

export const MOODLE_READ_ONLY_FUNCTIONS = new Set([
  ...REQUIRED_FUNCTIONS,
  ...OPTIONAL_FUNCTIONS
]);

export class MoodleWebServiceError extends ChangefeedError {
  constructor(
    message,
    { code = "moodle_request_failed", errorCode = "", functionName = "" } = {}
  ) {
    super(code, message);
    this.name = "MoodleWebServiceError";
    this.errorCode = errorCode;
    this.functionName = functionName;
  }
}

function appendParameter(params, key, value) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      if (item && typeof item === "object") {
        for (const [childKey, childValue] of Object.entries(item)) {
          appendParameter(params, `${key}[${index}][${childKey}]`, childValue);
        }
      } else {
        appendParameter(params, `${key}[${index}]`, item);
      }
    });
    return;
  }
  if (value !== undefined && value !== null) params.append(key, String(value));
}

export class MoodleMobileClient {
  constructor({ siteKey, credentialProvider, fetchImpl = globalThis.fetch }) {
    if (typeof credentialProvider?.getWebServiceToken !== "function") {
      throw new TypeError("credentialProvider.getWebServiceToken() is required");
    }
    if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl is required");
    this.siteKey = canonicalSiteKey(siteKey);
    this.siteUrl = this.siteKey;
    this.credentialProvider = credentialProvider;
    this.fetchImpl = fetchImpl;
  }

  async #token() {
    const token = await this.credentialProvider.getWebServiceToken();
    if (typeof token !== "string" || token.length === 0) {
      throw new MoodleWebServiceError("Missing Moodle Web Service credential", {
        code: "moodle_credential_missing"
      });
    }
    return token;
  }

  async call(functionName, parameters = {}) {
    if (!MOODLE_READ_ONLY_FUNCTIONS.has(functionName)) {
      throw new MoodleWebServiceError(
        `拒绝调用非只读 Moodle 函数：${functionName}`,
        { code: "moodle_function_not_allowed", functionName }
      );
    }
    const token = await this.#token();
    const body = new URLSearchParams({
      wstoken: token,
      wsfunction: functionName,
      moodlewsrestformat: "json"
    });
    for (const [key, value] of Object.entries(parameters)) {
      appendParameter(body, key, value);
    }

    let response;
    try {
      response = await this.fetchImpl(
        `${this.siteKey}/webservice/rest/server.php`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body,
          redirect: "manual",
          signal: AbortSignal.timeout(30000)
        }
      );
    } catch {
      throw new MoodleWebServiceError("Moodle Web Service network request failed", {
        functionName
      });
    }
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      throw new MoodleWebServiceError("Moodle Web Service redirect rejected", {
        code: "moodle_redirect_rejected",
        functionName
      });
    }
    if (!response.ok) {
      throw new MoodleWebServiceError(
        `Moodle Web Service returned HTTP ${response.status}`,
        { functionName }
      );
    }
    let data;
    try {
      data = await response.json();
    } catch {
      throw new MoodleWebServiceError("Moodle Web Service returned non-JSON data", {
        functionName
      });
    }
    if (data?.exception || data?.errorcode) {
      const errorCode = data.errorcode || "";
      throw new MoodleWebServiceError("Moodle rejected the read-only request", {
        code:
          OPTIONAL_FUNCTIONS.includes(functionName) &&
          CAPABILITY_UNAVAILABLE_ERROR_CODES.has(errorCode)
            ? "capability_unavailable"
            : "moodle_request_failed",
        errorCode,
        functionName
      });
    }
    return data;
  }

  getSiteInfo() {
    return this.call("core_webservice_get_site_info");
  }

  getUserCourses(userId) {
    return this.call("core_enrol_get_users_courses", { userid: userId });
  }

  getCourseContents(courseId) {
    return this.call("core_course_get_contents", { courseid: courseId });
  }

  async fetchResource(locator, { signal } = {}) {
    let normalized;
    try {
      const pathname = locator?.pathname;
      if (
        typeof pathname !== "string" ||
        !pathname.startsWith("/") ||
        pathname.startsWith("//") ||
        pathname.includes("://") ||
        pathname.includes("?") ||
        pathname.includes("#")
      ) {
        throw new Error("invalid pathname");
      }
      normalized = normalizeResourceLocator(
        new URL(pathname, `${this.siteKey}/`).toString(),
        { siteKey: this.siteKey }
      );
    } catch {
      throw new MoodleWebServiceError("Moodle 资源路径不在允许范围内。", {
        code: "moodle_resource_locator_rejected"
      });
    }
    const token = await this.#token();
    const url = new URL(normalized.pathname, `${this.siteKey}/`);
    url.searchParams.set("token", token);
    if (locator.forcedownload === true) url.searchParams.set("forcedownload", "1");

    let response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method: "GET",
        redirect: "manual",
        signal: signal || AbortSignal.timeout(60000)
      });
    } catch {
      throw new MoodleWebServiceError("Moodle resource network request failed");
    }
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      throw new MoodleWebServiceError("Moodle 资源下载拒绝重定向。", {
        code: "moodle_redirect_rejected"
      });
    }
    if (!response.ok) {
      throw new MoodleWebServiceError(
        `Moodle resource request returned HTTP ${response.status}`
      );
    }
    const safeUrl = `${new URL(this.siteKey).origin}${normalized.pathname}`;
    return new Proxy(response, {
      get(target, property) {
        if (property === "url") return safeUrl;
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
  }
}
