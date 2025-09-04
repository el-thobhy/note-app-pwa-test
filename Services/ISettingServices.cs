using ELAuth.ViewModel;

namespace NoteAppPWA.Services
{
    public interface ISettingServices
    {
        Task<LoginResponseViewModel> UpdateProfilePhoto(string id, string userName, IFormFile file);
    }
}
