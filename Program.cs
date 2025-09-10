using NoteApp.Services;
using NoteAppPWA.Helper;
using NoteAppPWA.Services;

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

app.UseAuthorization();

app.MapControllerRoute(
    name: "default",
    pattern: "{controller=Home}/{action=Index}/{id?}");

app.Run();
