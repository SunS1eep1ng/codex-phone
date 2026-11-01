package io.github.suns1eep1ng.codexphone;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.graphics.Color;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.view.View;
import android.view.WindowInsets;
import android.view.inputmethod.InputMethodManager;
import android.webkit.CookieManager;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.PopupMenu;
import android.widget.ScrollView;
import android.widget.TextView;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

public class MainActivity extends Activity {
  private final ExecutorService network=Executors.newSingleThreadExecutor();
  private SharedPreferences saved;
  private LinearLayout root;
  private EditText gatewayInput,codeInput;
  private TextView message;
  private WebView web;
  private ValueCallback<Uri[]> fileChooser;
  private boolean connecting=false,renewing=false;
  private long lastAuth=0;
  private long connectionGeneration=0;
  private int reconnectAttempt=0;
  private String expectedDevice="",pendingLink="";
  private int background=Color.rgb(244,246,249),foreground=Color.rgb(25,32,45);
  private String t(String zh,String en){return getResources().getConfiguration().getLocales().get(0).getLanguage().equals("zh")?zh:en;}
  private static class ApiException extends Exception { final String code; ApiException(String c,String text){super(text);code=c;} }
  private boolean permanent(Exception e){return e instanceof ApiException && java.util.Arrays.asList("phone_not_authorized","wrong_computer").contains(((ApiException)e).code);}
  private static final int FILE_REQUEST=420;
  private static class ApiResult { JSONObject body;String cookie;ApiResult(JSONObject b,String c){body=b;cookie=c;} }
  @Override public void onCreate(Bundle state){
    super.onCreate(state);saved=getSharedPreferences("connection",MODE_PRIVATE);
    if(Build.VERSION.SDK_INT>=30)getWindow().setDecorFitsSystemWindows(false);
    if((getResources().getConfiguration().uiMode&Configuration.UI_MODE_NIGHT_MASK)==Configuration.UI_MODE_NIGHT_YES){background=Color.rgb(20,24,31);foreground=Color.rgb(235,239,247);}
    if(getIntent().getData()!=null){showPairing(getIntent().getData().toString());}
    else if(saved.contains("credential")){connect(false);}
    else showPairing("");
  }
  @Override protected void onNewIntent(Intent intent){super.onNewIntent(intent);setIntent(intent);if(intent.getData()!=null)showPairing(intent.getData().toString());}
  @Override protected void onResume(){super.onResume();if(web!=null&&saved.contains("credential")&&SystemClock.elapsedRealtime()-lastAuth>300000&&!connecting&&!renewing)renewSilently();}
  private int dp(int value){return Math.round(value*getResources().getDisplayMetrics().density);}
  private TextView text(String value,int size){TextView v=new TextView(this);v.setText(value);v.setTextColor(foreground);v.setTextSize(size);v.setPadding(0,dp(8),0,dp(8));return v;}
  private Button button(String label,View.OnClickListener click){Button b=new Button(this);b.setText(label);b.setOnClickListener(click);return b;}
  private void layout(){
    if(web!=null){web.stopLoading();web.destroy();web=null;}
    root=new LinearLayout(this);root.setOrientation(LinearLayout.VERTICAL);root.setBackgroundColor(background);
    root.setOnApplyWindowInsetsListener((view,insets)->{if(Build.VERSION.SDK_INT>=30){android.graphics.Insets bars=insets.getInsets(WindowInsets.Type.systemBars());int bottom=Math.max(bars.bottom,insets.getInsets(WindowInsets.Type.ime()).bottom);view.setPadding(bars.left,bars.top,bars.right,bottom);}return insets;});
    setContentView(root);
  }
  private void showPairing(String link){
    connectionGeneration++;connecting=false;layout();pendingLink=link;expectedDevice="";
    ScrollView scroll=new ScrollView(this);LinearLayout box=new LinearLayout(this);box.setOrientation(LinearLayout.VERTICAL);box.setPadding(dp(24),dp(22),dp(24),dp(22));scroll.addView(box);root.addView(scroll);
    box.addView(text(t("连接你的电脑","Connect your computer"),27));box.addView(text(t("首次配对后，点开应用即可继续电脑上的 Codex 会话。","Pair once, then open the app to continue your native Desktop conversations."),15));
    box.addView(text(t("连接入口","Gateway address"),14));gatewayInput=new EditText(this);gatewayInput.setTextColor(foreground);gatewayInput.setSingleLine(true);gatewayInput.setInputType(17);gatewayInput.setHint("https://…workers.dev");
    String defaultGateway=saved.getString("gateway",getString(R.string.default_gateway));gatewayInput.setText(defaultGateway);box.addView(gatewayInput);
    box.addView(text(t("电脑配对页上的 8 位配对码","8-digit code from your computer"),14));codeInput=new EditText(this);codeInput.setTextColor(foreground);codeInput.setSingleLine(true);codeInput.setInputType(2);codeInput.setHint(t("配对码","Pairing code"));box.addView(codeInput);
    box.addView(button(t("粘贴配对链接","Paste pairing link"),v->{ClipboardManager clipboard=(ClipboardManager)getSystemService(CLIPBOARD_SERVICE);ClipData clip=clipboard.getPrimaryClip();if(clip!=null&&clip.getItemCount()>0)fillLink(clip.getItemAt(0).coerceToText(this).toString());}));
    box.addView(button(t("配对并连接","Pair and connect"),v->pair()));message=text(t("在电脑开始菜单搜索“Codex 手机配对”可生成新的配对码。","On your PC, open Codex Phone Pair from the Start menu."),14);box.addView(message);
    if(!link.isEmpty())fillLink(link);
  }
  private void fillLink(String value){
    try{Uri uri=Uri.parse(value.trim());if(!"codexphone-public".equals(uri.getScheme())||!"pair".equals(uri.getHost()))throw new Exception();
      gatewayInput.setText(uri.getQueryParameter("gateway"));codeInput.setText(uri.getQueryParameter("code"));expectedDevice=uri.getQueryParameter("device");if(expectedDevice==null)expectedDevice="";message.setText(t("配对链接已填入，请确认连接入口后点击“配对并连接”。","Check the gateway address, then tap Pair and connect."));
    }catch(Exception e){message.setText(t("这不是有效的 Codex Phone 配对链接。","Invalid Codex Phone pairing link."));}
  }
  private String normalizedGateway(String raw)throws Exception{
    URL url=new URL(raw.trim());if(!"https".equals(url.getProtocol())||url.getUserInfo()!=null||url.getHost().isEmpty()||url.getQuery()!=null||url.getRef()!=null||(!url.getPath().isEmpty()&&!"/".equals(url.getPath())))throw new Exception(t("请输入完整的 HTTPS 连接入口。","Enter a full HTTPS gateway origin."));
    return url.getProtocol()+"://"+url.getAuthority();
  }
  private ApiResult api(String gateway,String route,JSONObject body)throws Exception{
    HttpURLConnection connection=(HttpURLConnection)new URL(gateway+route).openConnection();connection.setConnectTimeout(12000);connection.setReadTimeout(20000);connection.setInstanceFollowRedirects(false);connection.setRequestProperty("Accept","application/json");
    try{if(body!=null){connection.setRequestMethod("POST");connection.setDoOutput(true);connection.setRequestProperty("Content-Type","application/json");byte[] bytes=body.toString().getBytes(StandardCharsets.UTF_8);connection.setFixedLengthStreamingMode(bytes.length);try(java.io.OutputStream output=connection.getOutputStream()){output.write(bytes);}}
      int status=connection.getResponseCode();InputStream input=status>=400?connection.getErrorStream():connection.getInputStream();ByteArrayOutputStream data=new ByteArrayOutputStream();if(input!=null)try(InputStream stream=input){byte[] bytes=new byte[4096];int n;while((n=stream.read(bytes))>=0){data.write(bytes,0,n);if(data.size()>65536)throw new Exception(t("电脑返回的数据异常。","Invalid response from computer."));}}
      JSONObject result;try{result=new JSONObject(data.toString("UTF-8"));}catch(Exception e){throw new Exception(t("连接入口暂未就绪，请稍后重试。","Gateway is not ready. Try again shortly."));}
      if(status<200||status>=300)throw new ApiException(result.optString("error"),readError(result.optString("error")));
      return new ApiResult(result,connection.getHeaderField("Set-Cookie"));
    }finally{connection.disconnect();}
  }
  private String readError(String key){
    if("phone_not_authorized".equals(key))return t("手机授权已失效或已被撤销，请重新配对。","Phone authorization expired or was revoked. Pair again.");
    if("invalid_pairing_code".equals(key))return t("配对码不正确，请检查电脑配对页。","Incorrect pairing code. Check the pairing page on your PC.");
    if("pairing_expired".equals(key))return t("配对码已过期，请在电脑上重新生成。","Pairing code expired. Generate a new one on your PC.");
    if("wrong_computer".equals(key))return t("这个入口连接的电脑与配对信息不一致。","Computer identity does not match this pairing.");
    return t("暂时无法连接电脑，请确认电脑上的 ChatGPT 已打开，稍后重试。","Computer unavailable. Check that Codex Desktop is open, then retry.");
  }
  private void pair(){
    if(connecting)return;final String gateway,code=codeInput.getText().toString().trim();
    try{gateway=normalizedGateway(gatewayInput.getText().toString());if(!code.matches("[0-9]{8}"))throw new Exception(t("请输入 8 位数字配对码。","Enter an 8-digit pairing code."));}catch(Exception e){message.setText(e.getMessage());return;}
    connecting=true;message.setText(t("正在验证电脑并配对…","Checking computer and pairing…"));final String wanted=expectedDevice;
    network.execute(()->{try{
      JSONObject info=api(gateway,"/phone-api/info",null).body;String device=info.getString("deviceId");if(!wanted.isEmpty()&&!wanted.equals(device))throw new Exception(t("入口与配对链接中的电脑不一致。","Gateway does not match the computer in the pairing link."));
      JSONObject data=new JSONObject().put("deviceId",device).put("code",code).put("name",Build.MANUFACTURER+" "+Build.MODEL);
      ApiResult linked=api(gateway,"/phone-api/pair",data);if(!device.equals(linked.body.getString("deviceId")))throw new Exception(t("电脑身份校验失败。","Computer identity check failed."));
      String encrypted=encrypt(linked.body.getString("credential"));saved.edit().putString("gateway",gateway).putString("device",device).putString("phone",linked.body.getString("phoneId")).putString("name",linked.body.getString("deviceName")).putString("credential",encrypted).remove("lastUrl").commit();
      installCookie(gateway,linked.cookie,()->showWeb(gateway));
    }catch(Exception e){runOnUiThread(()->{connecting=false;message.setText(e.getMessage()==null?t("连接失败，请重试。","Connection failed. Try again."):e.getMessage());});}});
  }
  private void connect(boolean quiet){
    if(connecting)return;final long generation=++connectionGeneration;connecting=true;if(!quiet){layout();root.setPadding(dp(24),dp(36),dp(24),dp(24));root.addView(text(t("正在连接电脑…","Connecting to computer…"),24));message=text(t("正在恢复已保存的手机授权。","Restoring saved phone authorization."),15);root.addView(message);}
    network.execute(()->{try{String gateway=saved.getString("gateway","");JSONObject data=credentials();ApiResult result=api(gateway,"/phone-api/session",data);if(!saved.getString("device","").equals(result.body.getString("deviceId")))throw new Exception(t("电脑身份校验失败。","Computer identity check failed."));installCookie(gateway,result.cookie,()->showWeb(gateway));}
      catch(Exception e){runOnUiThread(()->{if(isFinishing()||isDestroyed()||generation!=connectionGeneration)return;String reason=e.getMessage();showError(reason);if(saved.contains("credential")&&reconnectAttempt<8&&!permanent(e)){int delay=Math.min(15000,1000*(1<<reconnectAttempt++));root.addView(text(t("正在等待电脑连接恢复，将自动重试。","Waiting for computer. Retrying automatically."),14));root.postDelayed(()->{if(!isFinishing()&&!isDestroyed()&&!connecting&&generation==connectionGeneration)connect(false);},delay);}});}});
  }
  private JSONObject credentials()throws Exception{return new JSONObject().put("deviceId",saved.getString("device","")).put("phoneId",saved.getString("phone","")).put("credential",decrypt(saved.getString("credential","")));}
  private void installCookie(String gateway,String cookie,Runnable done)throws Exception{
    if(cookie==null||!cookie.startsWith("bridge_phone_session="))throw new Exception(t("电脑没有返回有效的手机会话。","Computer did not return a valid phone session."));
    runOnUiThread(()->{if(isFinishing()||isDestroyed())return;CookieManager manager=CookieManager.getInstance();manager.setAcceptCookie(true);manager.setCookie(gateway,cookie,ok->{if(network.isShutdown())return;network.execute(()->{manager.flush();runOnUiThread(()->{if(isFinishing()||isDestroyed())return;connecting=false;renewing=false;reconnectAttempt=0;lastAuth=SystemClock.elapsedRealtime();done.run();});});});});
  }
  private void renewSilently(){
    renewing=true;network.execute(()->{try{String gateway=saved.getString("gateway","");ApiResult result=api(gateway,"/phone-api/session",credentials());installCookie(gateway,result.cookie,()->{});}catch(Exception e){runOnUiThread(()->{renewing=false;});}});
  }
  private void showError(String reason){
    connecting=false;layout();root.setPadding(dp(24),dp(30),dp(24),dp(24));root.addView(text(t("暂时没有连接上电脑","Computer unavailable"),24));root.addView(text(reason==null?t("请确认电脑联网并已打开 ChatGPT。","Check that your PC is online and Codex Desktop is open."):reason,15));root.addView(button(t("重试","Retry"),v->connect(false)));root.addView(button(t("重新配对","Pair again"),v->showPairing("")));
  }
  private boolean sameOrigin(String value){try{return new URL(value).getAuthority().equals(new URL(saved.getString("gateway","")).getAuthority())&&"https".equals(new URL(value).getProtocol());}catch(Exception e){return false;}}
  private void showWeb(String gateway){
    layout();LinearLayout bar=new LinearLayout(this);bar.setOrientation(LinearLayout.HORIZONTAL);bar.setPadding(dp(12),0,dp(8),0);
    TextView title=text(saved.getString("name",t("我的电脑","My computer")),13);bar.addView(title,new LinearLayout.LayoutParams(0,dp(42),1));Button menu=button("⋮",v->{PopupMenu popup=new PopupMenu(this,v);popup.getMenu().add(t("重新连接","Reconnect")).setOnMenuItemClickListener(item->{connect(false);return true;});popup.getMenu().add(t("解除手机绑定","Unpair phone")).setOnMenuItemClickListener(item->{confirmUnpair();return true;});popup.show();});bar.addView(menu,new LinearLayout.LayoutParams(dp(48),dp(42)));root.addView(bar);
    web=new WebView(this);web.setBackgroundColor(background);root.addView(web,new LinearLayout.LayoutParams(-1,0,1));WebSettings settings=web.getSettings();settings.setJavaScriptEnabled(true);settings.setDomStorageEnabled(true);settings.setAllowFileAccess(false);settings.setAllowContentAccess(true);settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);settings.setMediaPlaybackRequiresUserGesture(true);CookieManager.getInstance().setAcceptThirdPartyCookies(web,false);
    web.setWebViewClient(new WebViewClient(){
      @Override public boolean shouldOverrideUrlLoading(WebView view,WebResourceRequest request){String value=request.getUrl().toString();if(sameOrigin(value)||"about:blank".equals(value))return false;if(request.isForMainFrame()&&(value.startsWith("https://")||value.startsWith("http://"))){try{startActivity(new Intent(Intent.ACTION_VIEW,request.getUrl()));}catch(Exception ignored){}}return true;}
      @Override public void doUpdateVisitedHistory(WebView view,String url,boolean reload){if(sameOrigin(url))saved.edit().putString("lastUrl",url).apply();}
      @Override public void onReceivedSslError(WebView view,SslErrorHandler handler,SslError error){handler.cancel();showError(t("连接证书验证失败，请检查入口地址和手机时间。","TLS verification failed. Check gateway address and phone clock."));}
      @Override public void onReceivedError(WebView view,WebResourceRequest request,WebResourceError error){if(request.isForMainFrame())showError(t("网页暂时无法加载，请检查手机网络后重试。","Page could not load. Check your network and retry."));}
      @Override public void onReceivedHttpError(WebView view,WebResourceRequest request,WebResourceResponse response){if(request.isForMainFrame()&&response.getStatusCode()>=400)showError(t("电脑入口暂时不可用，请稍后重试。","Computer gateway unavailable. Try again shortly."));}
    });
    web.setWebChromeClient(new WebChromeClient(){@Override public boolean onShowFileChooser(WebView view,ValueCallback<Uri[]> callback,FileChooserParams params){if(fileChooser!=null)fileChooser.onReceiveValue(null);fileChooser=callback;try{startActivityForResult(params.createIntent(),FILE_REQUEST);}catch(Exception e){fileChooser.onReceiveValue(null);fileChooser=null;return false;}return true;}});
    String last=saved.getString("lastUrl","");web.loadUrl(sameOrigin(last)?last:gateway+"/#/device/"+saved.getString("device",""));
  }
  private void confirmUnpair(){new AlertDialog.Builder(this).setTitle(t("解除手机绑定？","Unpair this phone?")).setMessage(t("解除后需要重新使用电脑上的配对码。电脑会话会保留。","You will need a new pairing code. Desktop conversations are kept.")).setNegativeButton(t("取消","Cancel"),null).setPositiveButton(t("解除绑定","Unpair"),(dialog,which)->{network.execute(()->{try{api(saved.getString("gateway",""),"/phone-api/unpair",credentials());runOnUiThread(()->{saved.edit().clear().apply();CookieManager.getInstance().removeAllCookies(ok->{CookieManager.getInstance().flush();showPairing("");});});}catch(Exception e){runOnUiThread(()->new AlertDialog.Builder(this).setMessage(t("暂时无法通知电脑解除授权，请联网后重试。","Could not notify computer. Reconnect and try again.")).setPositiveButton(t("知道了","OK"),null).show());}});}).show();}
  private SecretKey key()throws Exception{
    KeyStore store=KeyStore.getInstance("AndroidKeyStore");store.load(null);String alias="codex-phone-credential";
    if(!store.containsAlias(alias)){KeyGenerator generator=KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore");generator.init(new KeyGenParameterSpec.Builder(alias,KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());generator.generateKey();}
    return (SecretKey)store.getKey(alias,null);
  }
  private String encrypt(String value)throws Exception{Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.ENCRYPT_MODE,key());return Base64.encodeToString(cipher.getIV(),Base64.NO_WRAP)+":"+Base64.encodeToString(cipher.doFinal(value.getBytes(StandardCharsets.UTF_8)),Base64.NO_WRAP);}
  private String decrypt(String value)throws Exception{String[] data=value.split(":",2);Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.DECRYPT_MODE,key(),new GCMParameterSpec(128,Base64.decode(data[0],Base64.NO_WRAP)));return new String(cipher.doFinal(Base64.decode(data[1],Base64.NO_WRAP)),StandardCharsets.UTF_8);}
  @Override protected void onActivityResult(int request,int result,Intent data){super.onActivityResult(request,result,data);if(request==FILE_REQUEST&&fileChooser!=null){fileChooser.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result,data));fileChooser=null;}}
  @Override public void onBackPressed(){if(web!=null&&web.canGoBack())web.goBack();else super.onBackPressed();}
  @Override protected void onDestroy(){if(fileChooser!=null){fileChooser.onReceiveValue(null);fileChooser=null;}if(web!=null){web.destroy();web=null;}network.shutdownNow();super.onDestroy();}
}
