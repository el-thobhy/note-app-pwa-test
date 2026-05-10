using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Mvc.Authorization;
using Microsoft.Extensions.Configuration.UserSecrets;
using Microsoft.IdentityModel.Tokens;
using NoteApp.Hubs;
using NoteApp.Services;
using NoteAppPWA.Helper;
using NoteAppPWA.Services;
using System.Text;

var builder = WebApplication.CreateBuilder(args);

var sessionTimeOut = builder.Configuration.GetSection("SessionSettings:IdleTimeoutMinutes").Get<int>();
// Menambahkan session services
builder.Services.AddDistributedMemoryCache(); // Menyimpan session di memori
builder.Services.AddSession(options =>
{
    options.IdleTimeout = TimeSpan.FromMinutes(sessionTimeOut); // Timeout session 30 menit
    options.Cookie.HttpOnly = true; // Menjamin hanya bisa diakses di server
    options.Cookie.IsEssential = true; // Pastikan cookie selalu dikirim meskipun tidak ada interaksi
    options.Cookie.MaxAge = options.IdleTimeout; // <== penting
});
// Add services to the container.
builder.Services.AddControllersWithViews();
builder.Services.AddSingleton<INoteService, NoteService>();
builder.Services.AddSingleton<IDailyEntryService, DailyEntryService>();
builder.Services.AddSingleton<ISettingServices, SettingServices>();
builder.Services.AddHttpClient();
builder.Services.AddHttpContextAccessor();
builder.Services.AddSingleton<IEmailHelper, EmailHelper>();
builder.Services.AddSignalR();
builder.Services.AddScoped<IFileHelper, FileHelper>();


builder.Services.AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme)
    .AddCookie(options =>
    {
        options.LoginPath = "/Auth/Index"; // Redirect ke halaman login jika tidak terautentikasi
        options.AccessDeniedPath = "/Auth/UnAuthorized"; // Path untuk un authorized
        options.Cookie.Name = "kukiApp"; // Nama cookie autentikasi
        options.Cookie.HttpOnly = true; // Mencegah akses JavaScript ke cookie
        options.Cookie.SecurePolicy = CookieSecurePolicy.Always; // Hanya kirim cookie melalui HTTPS
        options.Cookie.SameSite = SameSiteMode.Lax;
        options.ExpireTimeSpan = TimeSpan.FromMinutes(sessionTimeOut); // Sesuaikan dengan kebutuhan
        options.SlidingExpiration = true; // Perbarui waktu kedaluwarsa pada setiap permintaan
    });

// Add Authorization
builder.Services.AddAuthorization(options =>
{
    options.AddPolicy("Guest", policy =>
        policy.RequireAssertion(ctx => !ctx.User.IsInRole("guest")
    ));
});
//Filter user dengan role "guest" tidak bisa mengakses aplikasi
builder.Services.AddControllersWithViews(options =>
{
    options.Filters.Add(new AuthorizeFilter("Guest"));
});

var app = builder.Build();

// Configure the HTTP request pipeline.
if (!app.Environment.IsDevelopment())
{
    app.UseExceptionHandler("/Home/Error");
}
// Gunakan session middleware sebelum routing
app.UseSession();

app.UseStaticFiles();

app.UseRouting();

app.UseAuthentication();

app.UseAuthorization();

app.MapControllerRoute(
    name: "default",
    pattern: "{controller=Home}/{action=Index}/{id?}");

app.MapHub<CollaborationHub>("/hubs/collaboration");

app.Run();
