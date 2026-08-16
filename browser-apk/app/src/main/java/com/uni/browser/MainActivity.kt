package com.uni.browser

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.os.Bundle
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.JavascriptInterface
import org.json.JSONObject
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL

@SuppressLint("SetJavaScriptEnabled")
class MainActivity : Activity() {

    private lateinit var webView: WebView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        try {
            webView = WebView(this)
            setContentView(webView)
            val settings = webView.settings
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = true
            settings.allowContentAccess = true
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            settings.cacheMode = WebSettings.LOAD_NO_CACHE
            webView.addJavascriptInterface(Bridge(this), "AndroidBridge")
            webView.loadUrl("file:///android_asset/index.html")
        } catch (t: Throwable) {
            android.widget.TextView(this).apply {
                text = "Ошибка: " + (t.message ?: t.toString())
            }.also { setContentView(it) }
        }
    }

    class Bridge(private val ctx: Context) {
        @JavascriptInterface
        fun backendBase(): String = "http://127.0.0.1:8765"

        @JavascriptInterface
        fun httpPost(url: String, jsonBody: String): String {
            return try {
                val conn = URL(url).openConnection() as HttpURLConnection
                conn.requestMethod = "POST"
                conn.connectTimeout = 90000
                conn.readTimeout = 90000
                conn.setRequestProperty("Content-Type", "application/json")
                conn.doOutput = true
                OutputStreamWriter(conn.outputStream).use { it.write(jsonBody) }
                val code = conn.responseCode
                val stream = if (code in 200..299) conn.inputStream else conn.errorStream
                val body = stream?.bufferedReader()?.use { it.readText() } ?: ""
                JSONObject().put("code", code).put("body", body).toString()
            } catch (e: Exception) {
                JSONObject().put("error", (e.message ?: e.toString())).toString()
            }
        }

        @JavascriptInterface
        fun fetchPage(url: String): String {
            return try {
                val conn = URL(url).openConnection() as HttpURLConnection
                conn.requestMethod = "GET"
                conn.connectTimeout = 25000
                conn.readTimeout = 25000
                conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Android) Uni-Browser")
                val code = conn.responseCode
                val stream = if (code in 200..299) conn.inputStream else conn.errorStream
                val body = stream?.bufferedReader()?.use { it.readText() } ?: ""
                JSONObject().put("code", code).put("body", body.take(200000)).toString()
            } catch (e: Exception) {
                JSONObject().put("error", (e.message ?: e.toString())).toString()
            }
        }
    }

    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        if (::webView.isInitialized && webView.canGoBack()) webView.goBack()
        else super.onBackPressed()
    }
}
