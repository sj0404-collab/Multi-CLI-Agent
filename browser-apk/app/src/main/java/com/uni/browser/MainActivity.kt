package com.uni.browser

import android.annotation.SuppressLint
import android.content.Context
import android.os.Bundle
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.JavascriptInterface
import androidx.appcompat.app.AppCompatActivity
import java.io.ByteArrayInputStream

@SuppressLint("SetJavaScriptEnabled")
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private val backendHost = "127.0.0.1:8765" // встроенный Python-сервер

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        webView = WebView(this)
        setContentView(webView)

        val settings = webView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.allowFileAccess = true
        settings.allowContentAccess = true
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        settings.cacheMode = WebSettings.LOAD_NO_CACHE

        // JS-мост для доступа к функциям Android (звук, токены)
        webView.addJavascriptInterface(Bridge(this), "AndroidBridge")

        webView.webViewClient = object : WebViewClient() {
            // AI/fetch-запросы перенаправляем на локальный сервер
            override fun shouldInterceptRequest(view: WebView, url: String): WebResourceResponse? {
                if (url.startsWith("/api/")) {
                    // локальный сервер обрабатывает /api/*
                    return null // пусть WebView грузит по относительному пути через assets-интерцептор ниже
                }
                return null
            }
        }

        // Загружаем браузер из assets (offline HTML/JS/CSS)
        webView.loadUrl("file:///android_asset/index.html")
    }

    class Bridge(private val ctx: Context) {
        @JavascriptInterface
        fun backendBase(): String = "http://127.0.0.1:8765"

        private var ttsEngine: android.speech.tts.TextToSpeech? = null

        @JavascriptInterface
        fun speak(text: String) {
            var tts = ttsEngine
            if (tts == null) {
                tts = android.speech.tts.TextToSpeech(ctx) { status ->
                    if (status == android.speech.tts.TextToSpeech.SUCCESS) {
                        ttsEngine?.language = java.util.Locale("ru", "RU")
                        ttsEngine?.speak(text, android.speech.tts.TextToSpeech.QUEUE_FLUSH, null, "mub")
                    }
                }
                ttsEngine = tts
                tts.language = java.util.Locale("ru", "RU")
                tts.speak(text, android.speech.tts.TextToSpeech.QUEUE_FLUSH, null, "mub")
            } else {
                tts.speak(text, android.speech.tts.TextToSpeech.QUEUE_FLUSH, null, "mub")
            }
        }
    }

    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        if (webView.canGoBack()) webView.goBack()
        else super.onBackPressed()
    }
}
