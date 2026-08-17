package com.uni.browser

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewAssetLoader
import org.json.JSONObject
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL

@SuppressLint("SetJavaScriptEnabled")
class MainActivity : Activity() {

    private lateinit var webView: WebView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Всё приложение лежит локально в assets.
        // WebViewAssetLoader отдаёт файлы по адресу https://appassets.androidplatform.net/assets/…
        // Это НАСТОЯЩИЙ безопасный origin (а не file://), поэтому React-модули,
        // сервис-воркеры и fetch работают без интернета — нет «фиолетового экрана».
        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webView = WebView(this)
        setContentView(webView)

        val s = webView.settings
        s.javaScriptEnabled = true
        s.domStorageEnabled = true
        s.allowFileAccess = true
        s.allowContentAccess = true
        s.allowUniversalAccessFromFileURLs = true
        s.allowFileAccessFromFileURLs = true
        s.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        s.cacheMode = WebSettings.LOAD_DEFAULT

        webView.addJavascriptInterface(Bridge(this), "AndroidBridge")

        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView?,
                request: WebResourceRequest?
            ): WebResourceResponse? {
                return loader.shouldInterceptRequest(request!!.url)
            }
        }

        // Грузим улучшенную читалку MangaLib Plus напрямую (без iframe).
        // Все ресурсы зашиты в APK — приложение полностью локальное.
        webView.loadUrl("https://appassets.androidplatform.net/assets/mangalib-plus.html")
    }

    class Bridge(private val ctx: Context) {
        @JavascriptInterface fun backendBase(): String = "https://appassets.androidplatform.net/assets/"
        @JavascriptInterface fun httpPost(url: String, jsonBody: String): String {
            return try {
                val conn = URL(url).openConnection() as HttpURLConnection
                conn.requestMethod = "POST"; conn.connectTimeout = 90000; conn.readTimeout = 90000
                conn.setRequestProperty("Content-Type", "application/json"); conn.doOutput = true
                OutputStreamWriter(conn.outputStream).use { it.write(jsonBody) }
                val code = conn.responseCode
                val stream = if (code in 200..299) conn.inputStream else conn.errorStream
                val body = stream?.bufferedReader()?.use { it.readText() } ?: ""
                JSONObject().put("code", code).put("body", body).toString()
            } catch (e: Exception) { JSONObject().put("error", (e.message ?: e.toString())).toString() }
        }
        @JavascriptInterface fun fetchPage(url: String): String {
            return try {
                val conn = URL(url).openConnection() as HttpURLConnection
                conn.requestMethod = "GET"; conn.connectTimeout = 25000; conn.readTimeout = 25000
                conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Android) Uni-Browser")
                val code = conn.responseCode
                val stream = if (code in 200..299) conn.inputStream else conn.errorStream
                val body = stream?.bufferedReader()?.use { it.readText() } ?: ""
                JSONObject().put("code", code).put("body", body.take(200000)).toString()
            } catch (e: Exception) { JSONObject().put("error", (e.message ?: e.toString())).toString() }
        }
    }

    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        if (::webView.isInitialized && webView.canGoBack()) webView.goBack() else super.onBackPressed()
    }
}
